# Research: vphone-cli — iOS Virtual Machine on Mac

**Task:** #1771
**Date:** 2026-03-02
**Status:** Research complete — not currently in use

## What is vphone-cli?

[vphone-cli](https://github.com/Lakr233/vphone-cli) is an open-source CLI tool by Lakr233 that boots a real, full iOS 26 system as a virtual machine on Mac using Apple's Virtualization.framework. This is not an emulator or simulator — it runs the actual iOS kernel and userspace.

## How it works

1. **Apple's Virtualization.framework** — The official Apple framework for running VMs on Apple Silicon
2. **PCC research VM infrastructure** — Repurposes Apple's Private Cloud Compute server-side VM components (`vphone600ap`) to boot iOS guests
3. **Boot chain patching** — Applies 41+ binary modifications across 6 boot components using binary analysis (not static offsets)
4. **Firmware merging** — Downloads iOS IPSWs, extracts, and merges them with PCC research elements
5. **Access** — Virtual iPhone accessible via SSH (port 22222) and VNC (port 5901)

## Requirements

- Apple Silicon Mac running macOS 26.3+
- SIP (System Integrity Protection) must be disabled
- AMFI must be disabled (`amfi_get_out_of_my_way=1`)
- Research guests enabled: `csrutil allow-research-guests enable`
- Dependencies: gnu-tar, sshpass, keystone, autoconf, automake, pkg-config, libtool

## Key difference from iOS Simulator

Xcode's iOS Simulator runs re-compiled iOS app code against macOS frameworks — it's not actually iOS. vphone-cli runs the real iOS kernel and full system inside a hardware-accelerated VM with GPU support.

## Use cases

- Automated iOS testing without physical devices
- CI/CD pipeline integration (spin up/down iOS VMs programmatically)
- Batch operations (create, manage, destroy multiple instances)
- Security research (low-level iOS system access via SSH)

## Are we using it?

**No.** push-todo-cli is a Node.js CLI that interfaces with the Push iOS app via Supabase. We don't build, compile, or test iOS code — so vphone-cli is not applicable to our workflow. iOS app testing would live in the iOS app's own repository.

## Limitations

- Requires disabling SIP and AMFI (significant security trade-off)
- Only works on macOS 26.3+ with Apple Silicon
- First boot requires manual console interaction for SSH key generation
- Licensed under WTFPL — no formal support guarantees
- Early-stage research tooling
