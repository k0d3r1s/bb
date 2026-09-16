#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
runtime_root=${BB_SHARED_RUNTIME_ROOT:-${HOME:?HOME is required}/.bb/shared-runtime}
project_id=${1:?project id is required}
safe_project_id=$(printf '%s' "$project_id" | LC_ALL=C sed 's/[^a-zA-Z0-9_.-]/_/g')
if [[ -z $safe_project_id ]]; then
    echo "project id must not be empty" >&2
    exit 2
fi

lock_root=$runtime_root/locks
lock_path=$lock_root/$safe_project_id.lock
status_path=$runtime_root/last-plugin-reload.$safe_project_id.status
status_temp=
owner_temp=
owner_serialized=
lock_acquired=0
state_directory_owned=0
state_claim_path=$lock_path.owner.json
state_claim_acquired=0
state_claim_id=
gate_path=
gate_directory_owned=0
gate_claim_path=
gate_claim_acquired=0
gate_claim_id=
claimed_owner_id=

read_process_identity() {
    local owner_pid=$1
    local boot_id
    local process_stat
    local stat_fields
    local start_ticks

    if [[ -r /proc/$owner_pid/stat && -r /proc/sys/kernel/random/boot_id ]]; then
        boot_id=$(sed -n '1p' /proc/sys/kernel/random/boot_id)
        IFS= read -r process_stat <"/proc/$owner_pid/stat"
        stat_fields=${process_stat##*) }
        start_ticks=$(awk '{print $20}' <<<"$stat_fields")
        [[ -n $boot_id && -n $start_ticks ]] || return 1
        printf 'proc:%s:%s\n' "$boot_id" "$start_ticks"
        return 0
    fi
    [[ -x /bin/ps ]] || return 1
    /bin/ps -o lstart= -p "$owner_pid" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

process_identity=$(read_process_identity "$$")
if [[ -z $process_identity ]]; then
    echo "cannot determine lock owner process identity" >&2
    exit 1
fi

mkdir -p -- "$lock_root"
find "$lock_root" -mindepth 1 -maxdepth 2 \
    \( \( -name '.*.init-*' -o -name '.*.init.*' \) -mmin +5 \
    -o -name '*.lock.retired-*' -mmin +5 \) \
    -exec rm -rf -- {} +

claim_owner() {
    local claim_path=$1
    local claim_parent=${claim_path%/*}
    local claim_name=${claim_path##*/}
    local claim_id
    local claim_parent_identity
    local current_parent_identity
    local link_attempt
    local link_output
    local link_status
    local misplaced_path
    local temp_output

    claim_parent_identity=$(directory_identity "$claim_parent") || return 3
    if ! temp_output=$(mktemp "$claim_parent/.${claim_name}.init.XXXXXX" 2>&1); then
        owner_temp=
        current_parent_identity=$(directory_identity "$claim_parent" || true)
        if [[ $current_parent_identity != "$claim_parent_identity" ]]; then
            return 3
        fi
        printf '%s\n' "$temp_output" >&2
        return 2
    fi
    owner_temp=$temp_output
    claim_id="$$-$(date +%s)-$RANDOM-$RANDOM"
    if ! printf '{"pid":%s,"createdAt":%s000,"id":"%s","processIdentity":"%s"}\n' \
        "$$" "$(date +%s)" "$claim_id" "$process_identity" >"$owner_temp"; then
        rm -f -- "$owner_temp"
        owner_temp=
        current_parent_identity=$(directory_identity "$claim_parent" || true)
        if [[ $current_parent_identity != "$claim_parent_identity" ]]; then
            return 3
        fi
        echo "cannot write lock owner claim temporary file: $claim_path" >&2
        return 2
    fi
    for link_attempt in 1 2; do
        link_status=0
        link_output=$(ln -- "$owner_temp" "$claim_path" 2>&1) || link_status=$?
        if (( link_status == 0 )) && [[ $owner_temp -ef $claim_path ]]; then
            claimed_owner_id=$claim_id
            rm -f -- "$owner_temp"
            owner_temp=
            return 0
        fi
        if (( link_status == 0 )); then
            misplaced_path=$claim_path/${owner_temp##*/}
            if [[ -e $owner_temp && -e $misplaced_path && $owner_temp -ef $misplaced_path ]]; then
                rm -f -- "$misplaced_path"
            fi
            current_parent_identity=$(directory_identity "$claim_parent" || true)
            if [[ $current_parent_identity != "$claim_parent_identity" ]]; then
                rm -f -- "$owner_temp"
                owner_temp=
                return 3
            fi
            echo "lock owner claim target is not a regular claim file: $claim_path" >&2
            rm -f -- "$owner_temp"
            owner_temp=
            return 2
        fi
        if [[ -e $claim_path || -L $claim_path ]]; then
            rm -f -- "$owner_temp"
            owner_temp=
            return 1
        fi
        current_parent_identity=$(directory_identity "$claim_parent" || true)
        if [[ $current_parent_identity != "$claim_parent_identity" ]]; then
            rm -f -- "$owner_temp"
            owner_temp=
            return 3
        fi
    done
    printf '%s\n' "$link_output" >&2
    rm -f -- "$owner_temp"
    owner_temp=
    return 2
}

read_owner_file() {
    local owner_path=$1

    owner_serialized=
    if [[ ! -e $owner_path && ! -L $owner_path ]]; then
        return 1
    fi
    [[ -f $owner_path ]] || return 1
    if ! owner_serialized=$(cat "$owner_path"); then
        if [[ ! -e $owner_path && ! -L $owner_path ]]; then
            return 1
        fi
        echo "cannot read lock owner metadata: $owner_path" >&2
        return 2
    fi
    return 0
}

owner_identifier() {
    local owner_path=$1
    local owner_id
    local owner_pid
    local owner_created_at
    local read_status=0

    read_owner_file "$owner_path" || read_status=$?
    (( read_status == 0 )) || return "$read_status"
    if ! owner_id=$(printf '%s\n' "$owner_serialized" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); then
        echo "cannot parse lock owner identifier: $owner_path" >&2
        return 2
    fi
    if [[ -n $owner_id ]]; then
        printf '%s\n' "$owner_id"
        return 0
    fi
    owner_pid=$(printf '%s\n' "$owner_serialized" | sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p') || return 2
    owner_created_at=$(printf '%s\n' "$owner_serialized" | sed -n 's/.*"createdAt":[[:space:]]*\([0-9][0-9]*\).*/\1/p') || return 2
    [[ -n $owner_pid && -n $owner_created_at ]] || return 1
    printf 'legacy-%s-%s\n' "$owner_pid" "$owner_created_at"
}

owner_created_at() {
    local owner_path=$1
    local created_at
    local read_status=0

    read_owner_file "$owner_path" || read_status=$?
    (( read_status == 0 )) || return "$read_status"
    created_at=$(printf '%s\n' "$owner_serialized" | sed -n 's/.*"createdAt":[[:space:]]*\([0-9][0-9]*\).*/\1/p') || return 2
    [[ -n $created_at ]] || return 1
    printf '%s\n' "$created_at"
}

claim_is_owned() {
    local claim_path=$1
    local expected_id=$2
    local current_id

    local ownership_status=0

    current_id=$(owner_identifier "$claim_path") || ownership_status=$?
    (( ownership_status == 0 )) || return "$ownership_status"
    [[ $current_id == "$expected_id" ]]
}

directory_identity() {
    local directory=$1

    [[ -d $directory ]] || return 1
    stat -c '%d-%i' -- "$directory" 2>/dev/null || stat -f '%d-%i' "$directory" 2>/dev/null
}

file_identity() {
    local file=$1

    stat -c '%d-%i' -- "$file" 2>/dev/null || stat -f '%d-%i' "$file" 2>/dev/null
}

lock_directory_identity() {
    local directory=$1
    shift
    local identity
    local marker_name
    local marker_path
    local marker_checksum
    local marker_identity

    identity=$(directory_identity "$directory") || return 1
    for marker_name in "$@"; do
        marker_path=$directory/$marker_name
        if [[ ! -e $marker_path && ! -L $marker_path ]]; then
            identity=$identity\|$marker_name:missing
            continue
        fi
        [[ -f $marker_path ]] || return 1
        marker_identity=$(file_identity "$marker_path") || return 1
        marker_checksum=$(cksum <"$marker_path") || return 1
        identity=$identity\|$marker_name:$marker_identity:$marker_checksum
    done
    printf '%s\n' "$identity"
}

process_started_at() {
    local identity=$1
    local start_ticks
    local uptime_seconds

    if [[ $identity == proc:* ]]; then
        start_ticks=${identity##*:}
        uptime_seconds=$(awk '{print $1}' /proc/uptime)
        awk -v now="$(date +%s)" -v uptime="$uptime_seconds" -v ticks="$start_ticks" \
            'BEGIN { printf "%.0f\n", now - uptime + (ticks / 100) }'
        return
    fi

    date -d "$identity" +%s 2>/dev/null ||
        date -j -f '%a %b %e %T %Y' "$identity" +%s 2>/dev/null
}

owner_is_live() {
    local owner_path=$1
    local actual_identity
    local owner_created_at
    local owner_created_seconds
    local owner_identity
    local owner_pid
    local read_status=0
    local started_at

    read_owner_file "$owner_path" || read_status=$?
    (( read_status == 0 )) || return "$read_status"
    owner_pid=$(printf '%s\n' "$owner_serialized" | sed -n 's/.*"pid":[[:space:]]*\([0-9][0-9]*\).*/\1/p') || return 2
    [[ -n $owner_pid ]] && kill -0 "$owner_pid" 2>/dev/null || return 1
    actual_identity=$(read_process_identity "$owner_pid") || return 0
    [[ -n $actual_identity ]] || return 0
    owner_identity=$(printf '%s\n' "$owner_serialized" | sed -n 's/.*"processIdentity":"\([^"]*\)".*/\1/p') || return 2
    if [[ -n $owner_identity ]]; then
        [[ $owner_identity == "$actual_identity" ]]
        return
    fi
    owner_created_at=$(printf '%s\n' "$owner_serialized" | sed -n 's/.*"createdAt":[[:space:]]*\([0-9][0-9]*\).*/\1/p') || return 2
    if [[ -n $owner_created_at ]] && started_at=$(process_started_at "$actual_identity"); then
        owner_created_seconds=$((owner_created_at / 1000))
        (( owner_created_seconds + 2 >= started_at ))
        return
    fi
    return 0
}

recover_claim() {
    local claim_path=$1
    local expected_id=$2
    local owned_path=${3:-}
    local candidate_path
    local candidate_created_at
    local claim_identity
    local current_identity
    local election_path=
    local election_created_at=
    local owner_status
    local ownership_status
    local recovery_prefix
    local recovery_path
    local recovery_status=0
    local -a recovery_paths

    claim_identity=$(file_identity "$claim_path") || return 1
    ownership_status=0
    claim_is_owned "$claim_path" "$expected_id" || ownership_status=$?
    if (( ownership_status != 0 )); then
        (( ownership_status == 2 )) && return 2
        return 1
    fi
    recovery_prefix=$claim_path.recover-$claim_identity-
    recovery_path=$recovery_prefix$$-$(date +%s)-$RANDOM-$RANDOM
    claim_owner "$recovery_path" || recovery_status=$?
    if (( recovery_status != 0 )); then
        if (( recovery_status == 2 )); then
            return 2
        fi
        return 1
    fi
    sleep 0.025
    shopt -s nullglob
    recovery_paths=("$recovery_prefix"*)
    shopt -u nullglob
    for candidate_path in ${recovery_paths[@]+"${recovery_paths[@]}"}; do
        owner_status=0
        owner_is_live "$candidate_path" || owner_status=$?
        if (( owner_status == 2 )); then
            rm -f -- "$recovery_path" || true
            return 2
        fi
        if (( owner_status == 0 )); then
            owner_status=0
            candidate_created_at=$(owner_created_at "$candidate_path") || owner_status=$?
            if (( owner_status == 2 )); then
                rm -f -- "$recovery_path" || true
                return 2
            fi
            if (( owner_status != 0 )) || [[ -z $candidate_created_at ]]; then
                if ! rm -f -- "$candidate_path"; then
                    echo "cannot remove invalid lock recovery contender: $candidate_path" >&2
                    rm -f -- "$recovery_path" || true
                    return 2
                fi
                continue
            fi
            if [[ -z $election_path ]] ||
                (( candidate_created_at < election_created_at )) ||
                { (( candidate_created_at == election_created_at )) &&
                    [[ $candidate_path < $election_path ]]; }; then
                election_path=$candidate_path
                election_created_at=$candidate_created_at
            fi
            continue
        fi
        if ! rm -f -- "$candidate_path"; then
            echo "cannot remove abandoned lock recovery contender: $candidate_path" >&2
            rm -f -- "$recovery_path" || true
            return 2
        fi
    done
    if [[ $election_path != "$recovery_path" ]]; then
        if ! rm -f -- "$recovery_path"; then
            echo "cannot withdraw lock recovery contender: $recovery_path" >&2
            return 2
        fi
        return 1
    fi
    current_identity=$(file_identity "$claim_path" || true)
    ownership_status=0
    claim_is_owned "$claim_path" "$expected_id" || ownership_status=$?
    if (( ownership_status == 2 )); then
        rm -f -- "$recovery_path" || true
        return 2
    fi
    if [[ $current_identity != "$claim_identity" ]] || (( ownership_status != 0 )); then
        rm -f -- "$recovery_path" || true
        return 1
    fi
    if [[ -n $owned_path ]]; then
        if ! rm -rf -- "$owned_path"; then
            echo "cannot remove directory protected by lock claim: $owned_path" >&2
            rm -f -- "$recovery_path" || true
            return 2
        fi
        current_identity=$(file_identity "$claim_path" || true)
        ownership_status=0
        claim_is_owned "$claim_path" "$expected_id" || ownership_status=$?
        if (( ownership_status == 2 )); then
            rm -f -- "$recovery_path" || true
            return 2
        fi
        if [[ $current_identity != "$claim_identity" ]] || (( ownership_status != 0 )); then
            rm -f -- "$recovery_path" || true
            return 1
        fi
    fi
    if ! rm -f -- "$claim_path"; then
        echo "cannot remove lock owner claim: $claim_path" >&2
        rm -f -- "$recovery_path" || true
        return 2
    fi
    if ! rm -f -- "$recovery_path"; then
        echo "cannot remove lock recovery contender: $recovery_path" >&2
        return 2
    fi
    return 0
}

release_owned_claim() {
    local claim_path=$1
    local expected_id=$2
    local owned_path=${3:-}
    local ownership_status
    local recovery_status

    ownership_status=0
    claim_is_owned "$claim_path" "$expected_id" || ownership_status=$?
    if (( ownership_status != 0 )); then
        echo "lost ownership of lock claim before release: $claim_path" >&2
        return 2
    fi
    while true; do
        recovery_status=0
        recover_claim "$claim_path" "$expected_id" "$owned_path" || recovery_status=$?
        if (( recovery_status == 0 )); then
            return 0
        fi
        if (( recovery_status == 2 )); then
            return 2
        fi
        ownership_status=0
        claim_is_owned "$claim_path" "$expected_id" || ownership_status=$?
        if (( ownership_status != 0 )); then
            echo "lost ownership of lock claim during release: $claim_path" >&2
            return 2
        fi
        sleep 0.025
    done
}

shopt -s nullglob
recovery_paths=("$lock_root"/*.owner.json.recover-* "$lock_root"/*/*.owner.json.recover-*)
shopt -u nullglob
for recovery_path in ${recovery_paths[@]+"${recovery_paths[@]}"}; do
    recovery_owner_status=0
    owner_is_live "$recovery_path" || recovery_owner_status=$?
    if (( recovery_owner_status == 2 )); then
        exit 1
    fi
    if (( recovery_owner_status == 1 )); then
        rm -f -- "$recovery_path"
    fi
done

cleanup() {
    if [[ -n ${status_temp:-} ]]; then
        rm -f -- "$status_temp"
    fi
    if [[ -n ${owner_temp:-} ]]; then
        rm -f -- "$owner_temp"
    fi
    if (( gate_claim_acquired )); then
        gate_owned_path=
        if (( gate_directory_owned )); then
            gate_owned_path=$gate_path
        fi
        if ! release_owned_claim "$gate_claim_path" "$gate_claim_id" "$gate_owned_path"; then
            echo "failed to release lock gate claim during cleanup: $gate_claim_path" >&2
        fi
    fi
    if (( state_claim_acquired )); then
        state_owned_path=
        if (( state_directory_owned )); then
            state_owned_path=$lock_path
        fi
        if ! release_owned_claim "$state_claim_path" "$state_claim_id" "$state_owned_path"; then
            echo "failed to release lock state claim during cleanup: $state_claim_path" >&2
        fi
    elif (( lock_acquired )); then
        rm -rf -- "$lock_path"
    fi
}
trap cleanup EXIT

while true; do
    if [[ -f $lock_path/rw.json ]]; then
        gate_path=$lock_path/gate.lock
        gate_claim_path=$gate_path.owner.json
        claim_status=0
        claim_owner "$gate_claim_path" || claim_status=$?
        if (( claim_status != 0 )); then
            if (( claim_status == 3 )); then
                continue
            fi
            if (( claim_status != 1 )); then
                exit 1
            fi
            gate_observed_status=0
            gate_observed_id=$(owner_identifier "$gate_claim_path") || gate_observed_status=$?
            if (( gate_observed_status != 0 )); then
                if (( gate_observed_status == 2 )); then
                    exit 1
                fi
                if [[ ! -e $gate_claim_path && ! -L $gate_claim_path ]] ||
                    [[ ! -d $lock_path ]]; then
                    continue
                fi
                echo "lock gate claim metadata is invalid: $gate_claim_path" >&2
                exit 1
            fi
            gate_owner_status=0
            owner_is_live "$gate_claim_path" || gate_owner_status=$?
            if (( gate_owner_status == 2 )); then
                exit 1
            fi
            if (( gate_owner_status == 0 )); then
                sleep 0.025
                continue
            fi
            recovery_status=0
            recover_claim "$gate_claim_path" "$gate_observed_id" || recovery_status=$?
            if (( recovery_status == 2 )); then
                exit 1
            fi
            sleep 0.025
            continue
        fi
        gate_claim_acquired=1
        gate_claim_id=$claimed_owner_id
        gate_owner_status=0
        owner_is_live "$gate_path/owner.json" || gate_owner_status=$?
        if (( gate_owner_status == 2 )); then
            if ! release_owned_claim "$gate_claim_path" "$gate_claim_id"; then
                exit 1
            fi
            gate_claim_acquired=0
            exit 1
        fi
        if (( gate_owner_status == 0 )); then
            if ! release_owned_claim "$gate_claim_path" "$gate_claim_id"; then
                exit 1
            fi
            gate_claim_acquired=0
            sleep 0.025
            continue
        fi
        if [[ -d $gate_path ]]; then
            if ! gate_directory_identity=$(lock_directory_identity "$gate_path" owner.json); then
                gate_ownership_status=0
                claim_is_owned "$gate_claim_path" "$gate_claim_id" || gate_ownership_status=$?
                if (( gate_ownership_status == 2 )); then
                    exit 1
                fi
                if (( gate_ownership_status == 1 )); then
                    gate_claim_acquired=0
                    continue
                fi
                if ! release_owned_claim "$gate_claim_path" "$gate_claim_id"; then
                    exit 1
                fi
                gate_claim_acquired=0
                sleep 0.025
                continue
            fi
            sleep 1
            gate_owner_status=0
            owner_is_live "$gate_path/owner.json" || gate_owner_status=$?
            if (( gate_owner_status == 2 )); then
                exit 1
            fi
            current_gate_directory_identity=$(lock_directory_identity "$gate_path" owner.json || true)
            gate_ownership_status=0
            claim_is_owned "$gate_claim_path" "$gate_claim_id" || gate_ownership_status=$?
            if (( gate_ownership_status == 2 )); then
                exit 1
            fi
            if (( gate_ownership_status == 1 )); then
                gate_claim_acquired=0
                continue
            fi
            if (( gate_owner_status == 0 )) ||
                [[ $current_gate_directory_identity != "$gate_directory_identity" ]]; then
                if ! release_owned_claim "$gate_claim_path" "$gate_claim_id"; then
                    exit 1
                fi
                gate_claim_acquired=0
                continue
            fi
        fi
        rm -rf -- "$gate_path"
        if ! mkdir "$gate_path" 2>/dev/null; then
            if [[ -d $gate_path ]]; then
                if ! release_owned_claim "$gate_claim_path" "$gate_claim_id"; then
                    exit 1
                fi
                gate_claim_acquired=0
                sleep 0.025
                continue
            fi
            gate_ownership_status=0
            claim_is_owned "$gate_claim_path" "$gate_claim_id" || gate_ownership_status=$?
            if (( gate_ownership_status == 2 )); then
                exit 1
            fi
            if (( gate_ownership_status == 1 )) || [[ ! -d $lock_path ]]; then
                gate_claim_acquired=0
                continue
            fi
            echo "cannot publish lock gate directory: $gate_path" >&2
            exit 1
        fi
        gate_directory_owned=1
        if ! cp -- "$gate_claim_path" "$gate_path/owner.json"; then
            echo "cannot publish lock gate owner metadata: $gate_path" >&2
            exit 1
        fi

        active_lease=0
        shopt -s nullglob
        lease_paths=("$lock_path"/readers/*.json "$lock_path"/writers/*.json)
        shopt -u nullglob
        for lease_path in ${lease_paths[@]+"${lease_paths[@]}"}; do
            lease_owner_status=0
            owner_is_live "$lease_path" || lease_owner_status=$?
            if (( lease_owner_status == 2 )); then
                if ! release_owned_claim "$gate_claim_path" "$gate_claim_id" "$gate_path"; then
                    exit 1
                fi
                gate_claim_acquired=0
                gate_directory_owned=0
                exit 1
            fi
            if (( lease_owner_status == 0 )); then
                active_lease=1
                continue
            fi
            rm -f -- "$lease_path"
        done
        if (( active_lease )); then
            gate_ownership_status=0
            claim_is_owned "$gate_claim_path" "$gate_claim_id" || gate_ownership_status=$?
            if (( gate_ownership_status == 2 )); then
                exit 1
            fi
            if (( gate_ownership_status == 1 )); then
                gate_claim_acquired=0
                gate_directory_owned=0
                continue
            fi
            if ! release_owned_claim "$gate_claim_path" "$gate_claim_id" "$gate_path"; then
                exit 1
            fi
            gate_claim_acquired=0
            gate_directory_owned=0
            sleep 0.1
            continue
        fi
        retired_lock_path=$lock_path.retired-$$-$(date +%s)-$RANDOM-$RANDOM
        while [[ -e $retired_lock_path || -L $retired_lock_path ]]; do
            retired_lock_path=$lock_path.retired-$$-$(date +%s)-$RANDOM-$RANDOM
        done
        mv -- "$lock_path" "$retired_lock_path"
        gate_claim_acquired=0
        gate_directory_owned=0
        rm -rf -- "$retired_lock_path"
        continue
    fi

    claim_status=0
    claim_owner "$state_claim_path" || claim_status=$?
    if (( claim_status != 0 )); then
        if (( claim_status == 3 )); then
            mkdir -p -- "$lock_root"
            continue
        fi
        if (( claim_status != 1 )); then
            exit 1
        fi
        state_observed_status=0
        state_observed_id=$(owner_identifier "$state_claim_path") || state_observed_status=$?
        if (( state_observed_status != 0 )); then
            if (( state_observed_status == 2 )); then
                exit 1
            fi
            if [[ ! -e $state_claim_path && ! -L $state_claim_path ]]; then
                continue
            fi
            echo "lock state claim metadata is invalid: $state_claim_path" >&2
            exit 1
        fi
        state_owner_status=0
        owner_is_live "$state_claim_path" || state_owner_status=$?
        if (( state_owner_status == 2 )); then
            exit 1
        fi
        if (( state_owner_status == 0 )); then
            sleep 0.1
            continue
        fi
        recovery_status=0
        recover_claim "$state_claim_path" "$state_observed_id" || recovery_status=$?
        if (( recovery_status == 2 )); then
            exit 1
        fi
        continue
    fi
    state_claim_acquired=1
    state_claim_id=$claimed_owner_id
    if [[ -f $lock_path/rw.json ]]; then
        if ! release_owned_claim "$state_claim_path" "$state_claim_id"; then
            exit 1
        fi
        state_claim_acquired=0
        continue
    fi
    state_owner_status=0
    owner_is_live "$lock_path/owner.json" || state_owner_status=$?
    if (( state_owner_status == 2 )); then
        if ! release_owned_claim "$state_claim_path" "$state_claim_id"; then
            exit 1
        fi
        state_claim_acquired=0
        exit 1
    fi
    if (( state_owner_status == 0 )); then
        if ! release_owned_claim "$state_claim_path" "$state_claim_id"; then
            exit 1
        fi
        state_claim_acquired=0
        sleep 0.1
        continue
    fi
    if [[ -d $lock_path ]]; then
        if ! state_directory_identity=$(lock_directory_identity "$lock_path" owner.json rw.json); then
            if ! release_owned_claim "$state_claim_path" "$state_claim_id"; then
                exit 1
            fi
            state_claim_acquired=0
            sleep 0.1
            continue
        fi
        sleep 1
        state_owner_status=0
        owner_is_live "$lock_path/owner.json" || state_owner_status=$?
        if (( state_owner_status == 2 )); then
            exit 1
        fi
        current_state_directory_identity=$(lock_directory_identity "$lock_path" owner.json rw.json || true)
        state_ownership_status=0
        claim_is_owned "$state_claim_path" "$state_claim_id" || state_ownership_status=$?
        if (( state_ownership_status == 2 )); then
            exit 1
        fi
        if (( state_ownership_status == 1 )); then
            state_claim_acquired=0
            continue
        fi
        if [[ -f $lock_path/rw.json ]] || (( state_owner_status == 0 )) ||
            [[ $current_state_directory_identity != "$state_directory_identity" ]]; then
            if ! release_owned_claim "$state_claim_path" "$state_claim_id"; then
                exit 1
            fi
            state_claim_acquired=0
            continue
        fi
    fi
    rm -rf -- "$lock_path"
    if ! mkdir "$lock_path" 2>/dev/null; then
        if [[ -d $lock_path ]]; then
            if ! release_owned_claim "$state_claim_path" "$state_claim_id"; then
                exit 1
            fi
            state_claim_acquired=0
            sleep 0.1
            continue
        fi
        state_ownership_status=0
        claim_is_owned "$state_claim_path" "$state_claim_id" || state_ownership_status=$?
        if (( state_ownership_status == 2 )); then
            exit 1
        fi
        if (( state_ownership_status == 1 )); then
            state_claim_acquired=0
            continue
        fi
        echo "cannot publish lock state directory: $lock_path" >&2
        exit 1
    fi
    state_directory_owned=1
    if ! cp -- "$state_claim_path" "$lock_path/owner.json"; then
        echo "cannot publish lock state owner metadata: $lock_path" >&2
        exit 1
    fi
    lock_acquired=1
    break
done

sleep 1
status_temp=$(mktemp "$runtime_root/last-plugin-reload.status.tmp.XXXXXX")
if output=$(bash "$ROOT/scripts/plugin-reload.sh" 2>&1); then
    printf 'ok\n%s\n' "$output" >"$status_temp"
    chmod 0600 "$status_temp"
    mv -- "$status_temp" "$status_path"
    trap - EXIT
    exit 0
else
    exit_code=$?
fi

printf 'failed exit=%s\n%s\n' "$exit_code" "$output" >"$status_temp"
chmod 0600 "$status_temp"
mv -- "$status_temp" "$status_path"
trap - EXIT
exit "$exit_code"
