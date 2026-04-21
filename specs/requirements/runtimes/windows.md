# Windows Runtime

## Original Notes

Windows is the other desktop OS. Most enterprise users are on Windows, and the system must work natively -- not as a second-class citizen with a compatibility layer. That means Windows Service management (SCM), native file paths (backslashes, drive letters, UNC paths), Windows-native persistence (AppData), proper NTFS semantics (case-insensitive but case-preserving), named pipes for IPC, and secure secret storage via DPAPI or Credential Manager. The process model is different: no fork(), signals work differently, and service lifecycle is SCM, not systemd.

The tension is that the FT system is developed primarily on Unix-like systems. Windows has fundamentally different conventions for paths, process management, persistence locations, and security. The runtime handles these differences without a leaky abstraction layer that breaks on edge cases.

## Problem Context

- **Actor(s)**: Windows end users; enterprise administrators; Windows Service Control Manager (SCM); PowerShell scripts; other local processes.
- **Domain**: Running the system natively on Windows as a first-class citizen, respecting Windows conventions for paths, persistence, services, IPC, and security.
- **Core Tension**: The system is developed primarily for Unix-like environments. Windows has fundamentally different conventions for paths (backslashes, drive letters, UNC), process management (SCM, not signals), persistence locations (AppData, not dotfiles), and security (DPAPI, not file permissions).

## Requirements

**R1**: The runtime SHALL handle Windows file paths correctly, including drive letters (C:\), UNC paths (\\server\share\), and long paths exceeding 260 characters.
- *Rationale*: Windows paths differ fundamentally from Unix paths; incorrect handling causes silent failures or data loss.
- *Verifiable by*: A path referencing `C:\Users\Jane\Documents\project\file.txt` resolves correctly. A UNC path `\\server\share\data.csv` resolves correctly. A path exceeding 260 characters resolves correctly via long path APIs.

**R2**: State SHALL persist to the standard Windows location (%LOCALAPPDATA%\FT), not Unix-style dotfiles.
- *Rationale*: Administrators expect data in standard Windows locations for backup, roaming profiles, and group policy management.
- *Verifiable by*: After writing state, the data directory is under %LOCALAPPDATA%, not in a dotfile under the user's home directory.

**R3**: The runtime SHALL support roaming profiles so that state follows the user across domain-joined machines.
- *Rationale*: Enterprise environments use roaming profiles; data stored only locally is lost when users switch machines.
- *Verifiable by*: Configure roaming persistence, write state on machine A, log in on machine B -- state is present.

**R4**: The runtime SHALL handle NTFS case-insensitive, case-preserving filename semantics and detect file locks from other processes.
- *Rationale*: NTFS behavior differs from Unix filesystems; ignoring this causes bugs on file operations.
- *Verifiable by*: Write to "Config.json", read "config.json" -- same content is returned. Attempt to write a file locked by another process -- the error is detected and handled (retry or reported).

**R5**: The runtime SHALL support running as a Windows Service via the Service Control Manager (SCM), with start, stop, restart, and automatic recovery.
- *Rationale*: Server deployments on Windows use SCM, not systemd; the system must integrate with standard Windows service management.
- *Verifiable by*: `sc start FTService` starts the service. `sc stop FTService` stops it with state persisted. SCM automatic recovery restarts the service after a crash.

**R6**: The runtime SHALL expose IPC via named pipes for local inter-process communication.
- *Rationale*: Named pipes are the standard Windows IPC mechanism; Unix sockets are not available.
- *Verifiable by*: A PowerShell script connects to the named pipe, submits a statement, and reads back state.

**R7**: The runtime SHALL handle Windows-native lifecycle events (service stop, system shutdown notification, console close, session change), persisting state before termination.
- *Rationale*: Windows does not use POSIX signals for process lifecycle; the runtime must handle Windows-specific events.
- *Verifiable by*: Initiate system shutdown -- the service receives the notification, persists state, and exits before the shutdown timeout.

**R8**: Secrets SHALL be stored encrypted via DPAPI or Windows Credential Manager, with no plaintext secrets on disk.
- *Rationale*: Plaintext secrets on disk are a critical security vulnerability, especially in enterprise environments.
- *Verifiable by*: Store an API key, inspect the data directory on disk -- no plaintext secrets are found. Retrieve the key via the runtime -- it is decrypted correctly.

**R9**: The runtime SHOULD provide a PowerShell module with cmdlets for native scripting integration.
- *Rationale*: Enterprise administrators automate with PowerShell; providing cmdlets enables integration with existing tooling.
- *Verifiable by*: `Import-Module FT; Get-FTState config.model` returns the expected value in PowerShell.

**R10**: HTTP operations SHALL honor system proxy settings without manual configuration.
- *Rationale*: Enterprise networks commonly use HTTP proxies; ignoring system settings causes connectivity failures.
- *Verifiable by*: On a system with a configured proxy, outbound HTTP requests route through the proxy without any explicit proxy configuration in the runtime.

## Acceptance Criteria

**AC1** [R1]: Given paths with drive letters, UNC prefixes, and lengths exceeding 260 characters, when file operations are performed, then all resolve correctly.

**AC2** [R2, R3]: Given state written to %LOCALAPPDATA%\FT with roaming enabled, when the user logs in on a different domain-joined machine, then the state is present.

**AC3** [R4]: Given a file "Config.json" written by the system and another process holding a lock on a different file, when "config.json" is read, then the correct content is returned; and when the locked file is written, then the lock is detected and reported.

**AC4** [R5]: Given an installed Windows Service, when `sc start`, `sc stop` are executed, then the service starts, stops with state persisted, and SCM recovery restarts it after a crash.

**AC5** [R6]: Given a named pipe endpoint, when a PowerShell script connects, submits a statement, and reads state, then the correct result is returned.

**AC6** [R7]: Given a running service, when a system shutdown is initiated, then the service persists state and exits before the shutdown timeout.

**AC7** [R8]: Given an API key stored via the runtime, when the data directory is inspected on disk, then no plaintext secrets are found.

**AC8** [R9]: Given the FT PowerShell module, when `Import-Module FT; Get-FTState config.model` is run, then the expected value is returned.

**AC9** [R10]: Given a system with a configured HTTP proxy, when the runtime makes an outbound HTTP request, then it routes through the proxy.

## FT System Demands

- **Required Primitives**: Windows-native path handling (drive letters, UNC, long paths). Named pipe IPC. DPAPI/Credential Manager integration.
- **Required Operations**: SCM service lifecycle management. NTFS-aware file operations. System proxy detection.
- **Gaps**: The abstraction layer must handle Windows/Unix path differences without leaking platform details to the rest of the system.

## Open Questions

- Should the PowerShell module be a binary module (C#) or a script module wrapping the CLI?
- How should the runtime handle the transition between local and roaming AppData for different deployment scenarios?
- What is the minimum supported Windows version (Windows 10, Windows Server 2016, etc.)?
