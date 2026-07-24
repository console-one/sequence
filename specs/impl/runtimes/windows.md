# Windows Runtime

Windows is the other desktop OS. Most enterprise users are on Windows, and the system must work natively -- not as a second-class citizen with a compatibility layer. That means Windows Service management (SCM), native file paths (backslashes, drive letters, UNC paths), Windows-native persistence (AppData), proper NTFS semantics (case-insensitive but case-preserving), named pipes for IPC, and secure secret storage via DPAPI or Credential Manager. The process model is different: no fork(), signals work differently, and service lifecycle is SCM, not systemd.

The tension is that the FT system is developed primarily on Unix-like systems. Windows has fundamentally different conventions for paths, process management, persistence locations, and security. The runtime handles these differences without a leaky abstraction layer that breaks on edge cases.

## Windows File Paths

The runtime handles drive letters, UNC paths, and long paths correctly:

```ft
WindowsPaths = {
  driveLetters: boolean,
  uncPaths: boolean,
  longPathSupport: boolean,
  maxPathLength: number >= 0
}
```

A store path referencing `C:\Users\Jane\Documents\project\file.txt` resolves correctly. UNC paths like `\\server\share\data.csv` resolve correctly. Paths exceeding 260 characters work via long path APIs.

## Native Persistence Location

State persists to the appropriate Windows location, not Unix-style dotfiles:

```ft
PersistenceLocation = {
  dataDir: string,
  windowsNative: boolean,
  roamingSupport: boolean
}
```

```ft
PersistenceLocation << { dataDir: "%LOCALAPPDATA%\\FT", windowsNative: true }
```

Administrators expect data in standard Windows locations for backup, roaming profiles, and group policy management.

## NTFS Semantics

The runtime handles NTFS case-insensitive but case-preserving filenames and file locking:

```ft
NTFSHandling = {
  caseInsensitive: boolean,
  casePreserving: boolean,
  fileLockDetection: boolean
}
```

Writing to "Config.json" and reading "config.json" returns the same content. File locks from other processes are detected and handled (retry or gap).

## Windows Service

The runtime supports running as a Windows Service via the Service Control Manager:

```ft
WindowsService = {
  serviceName: string,
  displayName: string,
  startType: "automatic" | "manual" | "disabled",
  status: "running" | "stopped" | "paused"
}
```

The service can be started via `sc start`, stopped via `sc stop`, and persists state on stop. SCM provides start, stop, restart, and automatic recovery.

## Named Pipe IPC

The runtime exposes IPC via named pipes, the standard Windows mechanism for local inter-process communication:

```ft
NamedPipeIPC = {
  pipeName: string,
  protocol: string,
  connectedClients: number >= 0
}
```

A PowerShell script can connect to the named pipe, submit a statement, and read back state.

## Windows Lifecycle Events

The runtime handles Windows-native lifecycle events, not POSIX signals:

```ft
WindowsLifecycle = {
  serviceStop: boolean,
  shutdownNotification: boolean,
  consoleClose: boolean,
  sessionChange: boolean
}
```

When the system begins shutdown, the runtime receives the notification, persists state, and exits before the shutdown timeout. Windows process management is not signal-based.

## Secure Secret Storage

Secrets are stored encrypted via DPAPI or Windows Credential Manager:

```ft
SecretStorage = {
  backend: "dpapi" | "credential-manager",
  encrypted: boolean,
  plaintextOnDisk: false
}
```

API keys stored via the runtime are encrypted. Inspecting the data directory on disk reveals no plaintext secrets.

## PowerShell Integration

PowerShell cmdlets provide native scripting:

```ft
PowerShellModule = {
  moduleName: string,
  cmdlets: number >= 0,
  importable: boolean
}
```

Enterprise administrators automate with `Import-Module FT; Get-FTState config.model` using the tools they already know.

## Proxy-Transparent Networking

HTTP capabilities honor system proxy settings:

```ft
ProxyConfig = {
  useSystemProxy: boolean,
  proxyDetected: boolean
}
```

On a system with a configured HTTP proxy, outbound requests from capabilities route through the proxy without manual configuration.

## What This Validates

| AC | Expressed by |
|----|-------------|
| Drive letters and UNC paths | `WindowsPaths` with full path support |
| Long paths above 260 chars | `WindowsPaths.longPathSupport` |
| Data in AppData, not dotfiles | `PersistenceLocation` with Windows-native dir |
| NTFS case-insensitive handling | `NTFSHandling.caseInsensitive` |
| Windows Service via SCM | `WindowsService` with start/stop/status |
| Named pipe IPC | `NamedPipeIPC` for local communication |
| Windows lifecycle events handled | `WindowsLifecycle` with shutdown notification |
| Encrypted secret storage | `SecretStorage.plaintextOnDisk = false` |
| PowerShell module | `PowerShellModule` for scripting |
| System proxy honored | `ProxyConfig.useSystemProxy` |
