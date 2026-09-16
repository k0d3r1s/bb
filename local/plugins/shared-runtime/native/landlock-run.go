//go:build linux

package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

const (
	landlockCreateRulesetVersion = 1
	landlockRulePathBeneath      = 1
	prSetNoNewPrivs              = 38
	prSetSeccomp                 = 22
	seccompModeFilter            = 2

	accessWriteFile  = uint64(1 << 1)
	accessRemoveDir  = uint64(1 << 4)
	accessRemoveFile = uint64(1 << 5)
	accessMakeChar   = uint64(1 << 6)
	accessMakeDir    = uint64(1 << 7)
	accessMakeReg    = uint64(1 << 8)
	accessMakeSock   = uint64(1 << 9)
	accessMakeFIFO   = uint64(1 << 10)
	accessMakeBlock  = uint64(1 << 11)
	accessMakeSym    = uint64(1 << 12)
	accessRefer      = uint64(1 << 13)
	accessTruncate   = uint64(1 << 14)

	sysLandlockCreateRuleset = uintptr(444)
	sysLandlockAddRule       = uintptr(445)
	sysLandlockRestrictSelf  = uintptr(446)
	oPath                    = 0x200000
	bpfLoadWordAbsolute      = 0x20
	bpfJumpEqualConstant     = 0x15
	bpfReturnConstant        = 0x06
	seccompReturnAllow       = 0x7fff0000
	seccompReturnErrno       = 0x00050000
)

type rulesetAttr struct {
	HandledAccessFS uint64
}

type pathBeneathAttr struct {
	AllowedAccess uint64
	ParentFD      int32
	Reserved      uint32
}

type socketFilter struct {
	Code uint16
	JT   uint8
	JF   uint8
	K    uint32
}

type socketFilterProgram struct {
	Length uint16
	_      [6]byte
	Filter *socketFilter
}

const xdebugLogPath = "/tmp/xdebug.log"

type stringList []string

func (values *stringList) String() string { return fmt.Sprint([]string(*values)) }
func (values *stringList) Set(value string) error {
	*values = append(*values, value)
	return nil
}

func landlockABI() (int, error) {
	value, _, errno := syscall.Syscall(
		sysLandlockCreateRuleset,
		0,
		0,
		landlockCreateRulesetVersion,
	)
	if errno != 0 {
		return 0, errno
	}
	return int(value), nil
}

func handledWriteAccess(abi int) uint64 {
	access := accessWriteFile | accessRemoveDir | accessRemoveFile |
		accessMakeChar | accessMakeDir | accessMakeReg | accessMakeSock |
		accessMakeFIFO | accessMakeBlock | accessMakeSym
	if abi >= 2 {
		access |= accessRefer
	}
	if abi >= 3 {
		access |= accessTruncate
	}
	return access
}

func writableFileAccess(abi int) uint64 {
	access := accessWriteFile
	if abi >= 3 {
		access |= accessTruncate
	}
	return access
}

func metadataMutationSyscalls() ([]uint32, error) {
	switch runtime.GOARCH {
	case "amd64":
		return []uint32{
			90, 91, 92, 93, 94, 132,
			188, 189, 190, 197, 198, 199,
			235, 260, 261, 268, 280, 452,
		}, nil
	case "arm64":
		return []uint32{
			5, 6, 7, 14, 15, 16,
			52, 53, 54, 55, 88, 452,
		}, nil
	default:
		return nil, fmt.Errorf("unsupported architecture for metadata isolation: %s", runtime.GOARCH)
	}
}

func restrictMetadataMutations() error {
	syscalls, err := metadataMutationSyscalls()
	if err != nil {
		return err
	}
	filters := []socketFilter{{Code: bpfLoadWordAbsolute, K: 0}}
	for _, number := range syscalls {
		filters = append(filters,
			socketFilter{Code: bpfJumpEqualConstant, JF: 1, K: number},
			socketFilter{Code: bpfReturnConstant, K: seccompReturnErrno | uint32(syscall.EPERM)},
		)
	}
	filters = append(filters, socketFilter{Code: bpfReturnConstant, K: seccompReturnAllow})
	program := socketFilterProgram{
		Length: uint16(len(filters)),
		Filter: &filters[0],
	}
	if _, _, errno := syscall.Syscall6(
		syscall.SYS_PRCTL,
		prSetSeccomp,
		seccompModeFilter,
		uintptr(unsafe.Pointer(&program)),
		0,
		0,
		0,
	); errno != 0 {
		return fmt.Errorf("install metadata seccomp filter: %w", errno)
	}
	return nil
}

func createRuleset(handled uint64) (int, error) {
	attr := rulesetAttr{HandledAccessFS: handled}
	fd, _, errno := syscall.Syscall(
		sysLandlockCreateRuleset,
		uintptr(unsafe.Pointer(&attr)),
		unsafe.Sizeof(attr),
		0,
	)
	if errno != 0 {
		return -1, errno
	}
	return int(fd), nil
}

func addPathRule(rulesetFD int, path string, allowed uint64) error {
	fd, err := syscall.Open(path, oPath|syscall.O_CLOEXEC|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open allowed path %s: %w", path, err)
	}
	defer syscall.Close(fd)
	attr := pathBeneathAttr{AllowedAccess: allowed, ParentFD: int32(fd)}
	_, _, errno := syscall.Syscall6(
		sysLandlockAddRule,
		uintptr(rulesetFD),
		landlockRulePathBeneath,
		uintptr(unsafe.Pointer(&attr)),
		0,
		0,
		0,
	)
	if errno != 0 {
		return fmt.Errorf("allow writes beneath %s: %w", path, errno)
	}
	return nil
}

func addWorkspaceRules(rulesetFD int, workspace string, handled uint64, abi int) error {
	entries, err := os.ReadDir(workspace)
	if err != nil {
		return fmt.Errorf("read workspace: %w", err)
	}
	fileAccess := writableFileAccess(abi)
	for _, entry := range entries {
		if entry.Name() == ".git" || entry.Name() == ".bb-runtime" {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return fmt.Errorf("inspect workspace entry %s: %w", entry.Name(), err)
		}
		if info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		allowed := fileAccess
		if info.IsDir() {
			allowed = handled
		} else if !info.Mode().IsRegular() {
			continue
		}
		if err := addPathRule(rulesetFD, filepath.Join(workspace, entry.Name()), allowed); err != nil {
			return err
		}
	}
	return nil
}

func ensureXdebugLog() error {
	fd, err := syscall.Open(
		xdebugLogPath,
		syscall.O_CREAT|syscall.O_APPEND|syscall.O_WRONLY|syscall.O_CLOEXEC|syscall.O_NOFOLLOW,
		0o666,
	)
	if err != nil {
		return fmt.Errorf("prepare Xdebug log: %w", err)
	}
	if err := syscall.Close(fd); err != nil {
		return fmt.Errorf("close Xdebug log: %w", err)
	}
	return nil
}

func restrictWrites(workspace string, scratch []string) error {
	if err := ensureXdebugLog(); err != nil {
		return err
	}
	abi, err := landlockABI()
	if err != nil {
		return fmt.Errorf("Landlock unavailable: %w", err)
	}
	if abi < 3 {
		return fmt.Errorf("Landlock ABI %d is unsupported", abi)
	}
	handled := handledWriteAccess(abi)
	rulesetFD, err := createRuleset(handled)
	if err != nil {
		return fmt.Errorf("create Landlock ruleset: %w", err)
	}
	defer syscall.Close(rulesetFD)
	if err := addWorkspaceRules(rulesetFD, workspace, handled, abi); err != nil {
		return err
	}
	for _, path := range scratch {
		info, err := os.Stat(path)
		if err != nil {
			return fmt.Errorf("inspect scratch path %s: %w", path, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("scratch path is not a directory: %s", path)
		}
		if err := addPathRule(rulesetFD, path, handled); err != nil {
			return err
		}
	}
	if _, _, errno := syscall.Syscall6(syscall.SYS_PRCTL, prSetNoNewPrivs, 1, 0, 0, 0, 0); errno != 0 {
		return fmt.Errorf("set no_new_privs: %w", errno)
	}
	if err := restrictMetadataMutations(); err != nil {
		return err
	}
	if err := addPathRule(rulesetFD, "/dev/null", writableFileAccess(abi)); err != nil {
		return fmt.Errorf("allow /dev/null writes: %w", err)
	}
	if err := addPathRule(rulesetFD, xdebugLogPath, writableFileAccess(abi)); err != nil {
		return fmt.Errorf("allow Xdebug log writes: %w", err)
	}
	if _, _, errno := syscall.Syscall(sysLandlockRestrictSelf, uintptr(rulesetFD), 0, 0); errno != 0 {
		return fmt.Errorf("restrict process with Landlock: %w", errno)
	}
	return nil
}

func expectWriteDenied(path string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err == nil {
		file.Close()
		return fmt.Errorf("write unexpectedly allowed: %s", path)
	}
	if !errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("write failed for an unexpected reason at %s: %w", path, err)
	}
	return nil
}

func expectMetadataDenied(path string) error {
	if err := os.Chmod(path, 0o600); err == nil {
		return fmt.Errorf("metadata write unexpectedly allowed: %s", path)
	} else if !errors.Is(err, os.ErrPermission) {
		return fmt.Errorf("metadata write failed for an unexpected reason at %s: %w", path, err)
	}
	return nil
}

func expectWriteAllowed(path string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		return fmt.Errorf("selected-worktree write was denied at %s: %w", path, err)
	}
	defer file.Close()
	if _, err := file.WriteString("allowed\n"); err != nil {
		return fmt.Errorf("selected-worktree write failed at %s: %w", path, err)
	}
	return nil
}

func expectTruncateAllowed(path string) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_TRUNC, 0)
	if err != nil {
		return fmt.Errorf("expected truncate of %s to succeed: %w", path, err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close truncated path %s: %w", path, err)
	}
	return nil
}

func runSelfTest(allowWrites []string, denyWrites []string, gitWorkspace string, gitRef string) error {
	if err := expectTruncateAllowed("/dev/null"); err != nil {
		return err
	}
	if err := expectWriteAllowed(xdebugLogPath); err != nil {
		return err
	}
	for _, path := range allowWrites {
		if err := expectWriteAllowed(path); err != nil {
			return err
		}
	}
	for _, path := range denyWrites {
		if err := expectWriteDenied(path); err != nil {
			return err
		}
		if err := expectMetadataDenied(path); err != nil {
			return err
		}
	}
	if gitWorkspace == "" || gitRef == "" {
		return errors.New("self-test requires git workspace and ref")
	}
	command := exec.Command(
		"git",
		"-C",
		gitWorkspace,
		"update-ref",
		"-m",
		"bb isolation probe",
		gitRef,
		"HEAD",
		"HEAD",
	)
	command.Env = append(os.Environ(), "LC_ALL=C")
	if output, err := command.CombinedOutput(); err == nil {
		return fmt.Errorf("direct Git ref mutation unexpectedly succeeded: %s", output)
	} else if !strings.Contains(strings.ToLower(string(output)), "permission denied") {
		return fmt.Errorf("direct Git ref mutation failed for an unexpected reason: %s", output)
	}
	return nil
}

func main() {
	var workspace string
	var scratches stringList
	var allowWrites stringList
	var denyWrites stringList
	var selfTest bool
	var gitWorkspace string
	var gitRef string
	flag.StringVar(&workspace, "workspace", "", "selected workspace root")
	flag.Var(&scratches, "scratch", "writable scratch directory")
	flag.Var(&allowWrites, "allow-write", "selected-worktree path whose write must succeed")
	flag.Var(&denyWrites, "deny-write", "path whose write must be denied")
	flag.BoolVar(&selfTest, "self-test", false, "run isolation acceptance probes")
	flag.StringVar(&gitWorkspace, "git-workspace", "", "workspace for direct Git probe")
	flag.StringVar(&gitRef, "git-ref", "", "existing ref for same-value mutation probe")
	flag.Parse()
	if workspace == "" {
		fmt.Fprintln(os.Stderr, "landlock-run: --workspace is required")
		os.Exit(2)
	}
	if err := restrictWrites(workspace, scratches); err != nil {
		fmt.Fprintf(os.Stderr, "landlock-run: %v\n", err)
		os.Exit(126)
	}
	if len(scratches) > 0 {
		if err := os.Setenv("GOCACHE", scratches[0]); err != nil {
			fmt.Fprintf(os.Stderr, "landlock-run: set GOCACHE: %v\n", err)
			os.Exit(1)
		}
	}
	if selfTest {
		if err := runSelfTest(allowWrites, denyWrites, gitWorkspace, gitRef); err != nil {
			fmt.Fprintf(os.Stderr, "landlock-run: %v\n", err)
			os.Exit(1)
		}
		fmt.Println("Landlock isolation probes passed")
		return
	}
	args := flag.Args()
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "landlock-run: command must follow --")
		os.Exit(2)
	}
	executable, err := exec.LookPath(args[0])
	if err != nil {
		fmt.Fprintf(os.Stderr, "landlock-run: resolve executable: %v\n", err)
		os.Exit(127)
	}
	if err := syscall.Exec(executable, args, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "landlock-run: exec: %v\n", err)
		os.Exit(127)
	}
}
