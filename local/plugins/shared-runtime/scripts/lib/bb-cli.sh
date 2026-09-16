#!/usr/bin/env bash

resolve_bb_cli() {
    local applications_root=${1:-/Applications}
    local candidate brew_command brew_package_root

    if [[ -n ${BB_CLI:-} ]]; then
        candidate=$BB_CLI
        [[ $candidate == /* && -f $candidate && -x $candidate ]] || {
            printf 'BB_CLI is not an existing absolute executable: %s\n' "$candidate" >&2
            return 1
        }
        realpath "$candidate"
        return
    fi

    if candidate=$(command -v bb) && \
        [[ $candidate == /* && -f $candidate && -x $candidate ]]; then
        realpath "$candidate"
        return
    fi

    for candidate in \
        "$applications_root/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb" \
        "$applications_root/BB.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/host-daemon/dist/bb" \
        /opt/homebrew/bin/bb \
        /usr/local/bin/bb; do
        if [[ -f $candidate && -x $candidate ]]; then
            realpath "$candidate"
            return
        fi
    done

    if brew_command=$(command -v brew) && \
        brew_package_root=$("$brew_command" --prefix bb); then
        for candidate in \
            "$brew_package_root/bin/bb" \
            "$brew_package_root/libexec/bin/bb" \
            "$brew_package_root/libexec/bb"; do
            if [[ -f $candidate && -x $candidate ]]; then
                realpath "$candidate"
                return
            fi
        done
    fi

    printf '%s\n' \
        'Could not resolve the BB CLI. Set BB_CLI to the absolute installed bb executable.' >&2
    return 1
}
