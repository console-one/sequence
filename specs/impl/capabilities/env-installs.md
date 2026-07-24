# Environment-Native Capability Installation

Every environment has a set of default capabilities that it natively provides. These are versioned, installed on boot, and available to any Sequence mounted within that environment.

## Original Notes

So these requirements should be built around the notion that every environment has a set of default capabilities that it is defined for and versioned across that it natively installs and makes available onto any kind of snapshot which is installed within it. For example, one of those capabilities for the environment install is going to be, in certain cases, the capability to install a capability through a variety of blueprint types which we support. Those blueprints could span from installing a set of HTTP labeled endpoints with a variety of constant-type input constraints that we've specialized or created templates for installing. Others could be actual classes in the specific runtime that are installed and labeled with particular contract I/O.

## The Core Pattern

An environment IS a capability manifest. When it boots a Sequence, it mounts its manifest — every capability it can provide, with typed schemas. The Sequence then knows what this environment can do before any user action occurs.

```ft
-- Every environment mounts its manifest on boot
env.manifest = [
  -- Identity
  env.id = string
  env.version = string
  env.runtime = "electron" | "node" | "browser" | "lambda"

  -- What this environment can natively do
  env.capabilities = [
    -- Meta-capability: install other capabilities from blueprints
    install = (blueprint: Blueprint) -> { ok: true, installedPath: string
      | env.capabilities HAS blueprint.provides  @[T_out..)
    }

    -- Meta-capability: uninstall a previously installed capability
    uninstall = (path: string) -> { ok: true
      | env.capabilities NOT HAS path  @[T_out..)
    }

    -- Version query
    version = () -> { version: string, capabilities: [string] }
  ]
]
```

The `install` capability is the critical one — it's the capability to install capabilities. Its behavioral predicate says: after installation, the installed blueprint's provided capabilities appear in the environment's capability set.

## Blueprint Types

Blueprints are typed installation recipes. Each blueprint type describes what it installs and how:

```ft
Blueprint = [
  -- What this blueprint provides when installed
  provides = [string]

  -- What this blueprint requires to be available before it can install
  requires = [string]

  -- The installation procedure (varies by blueprint type)
  type = "http-endpoints" | "runtime-class" | "ft-document" | "tool-adapter"
]

HttpEndpointBlueprint = Blueprint & [
  type = "http-endpoints"
  endpoints = [{
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    input: _,
    output: _,
    headers?: { [string]: string }
  }]
]

FtDocumentBlueprint = Blueprint & [
  type = "ft-document"
  -- The ft blocks in the document ARE the installation
  -- Extracting and mounting them installs the capabilities
  source = string   -- path to the markdown document
]
```

## Requirements

**R1**: Every environment SHALL declare a versioned capability manifest that is mounted onto the Sequence on boot, before any user interaction.
- *Rationale*: The Sequence must know what this environment can do. Without the manifest, gap resolution has no capabilities to match against.
- *Verifiable by*: After boot, `seq.projection.capabilities` includes all manifest entries.

**R2**: The environment manifest SHALL include a meta-capability for installing new capabilities from blueprints.
- *Rationale*: The system needs to grow — users install connectors, tools, agents. The install capability is HOW growth happens. Without it, the environment is static.
- *Verifiable by*: After boot, `seq.projection.capabilities.has('env.install')` is true.

**R3**: Blueprint installation SHALL be typed — the blueprint declares what it provides, what it requires, and the installation procedure. The system SHALL reject installation of a blueprint whose requirements are not met.
- *Rationale*: A blueprint that requires S3 access can't install on an environment without S3 credentials. Pre-validation prevents partial installations.
- *Verifiable by*: Installing a blueprint with unmet requirements suspends (where clause on requirements).

**R4**: After installation, the capabilities provided by the blueprint SHALL be available in the Sequence's capability set and discoverable by gap resolution.
- *Rationale*: The whole point — installed capabilities fill gaps. If they're not discoverable after installation, installation was pointless.
- *Verifiable by*: After installing a blueprint that provides `db.query`, `seq.gaps()` for a task needing query capabilities finds `db.query`.

**R5**: Capability uninstallation SHALL remove the capability from the Sequence and invalidate any active behavioral predicates that reference it.
- *Rationale*: A capability that's been uninstalled can't fulfill commitments. Active predicates referencing it must degrade.
- *Verifiable by*: After uninstalling a capability, its reliability prior drops and dependent gaps resurface.

**R6**: Environment manifests SHALL be versioned. A Sequence restored from a snapshot SHALL detect if the environment version has changed and reconcile capability differences.
- *Rationale*: Environment updates may add, remove, or change capabilities. A snapshot from v1 loaded on v2 needs to know what changed.
- *Verifiable by*: Loading a v1 snapshot on a v2 environment surfaces new capabilities and flags removed ones.

## FT System Demands

- The environment contract (`Environment.mountCapabilities`) already handles R1
- Blueprint installation IS `mount('schema', path, type) + mount('cap', path, impl)` with a `where` clause on prerequisites — already supported
- Uninstallation IS `mount('delete', path)` which removes the capability — already supported
- Version reconciliation IS diff between snapshot capabilities and current manifest — a comparison at boot time

No kernel changes needed. This is application-layer patterns over the existing mount/cap/where/delete operations.
