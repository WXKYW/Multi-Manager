# ADR-0001: Managed proxy runtime

- Status: Accepted
- Date: 2026-07-22

## Decision

API Monitor keeps its Rust Agent as the single host control module. The Agent
manages a pinned sing-box data-plane runtime; API Monitor does not
implement proxy protocols and does not copy Xboard-Node implementation code.

A new server is bootstrapped exactly once with this Agent. After enrollment,
the panel uses that same outbound Agent connection for host inventory,
monitoring, proxy-core installation and upgrades, internal-node lifecycle,
configuration reconciliation, health checks, traffic counters, and teardown.
sing-box is a replaceable data-plane process managed by the Agent;
they are not additional management Agents and require no separate panel
enrollment. Normal lifecycle operations must not depend on interactive SSH.

The panel stores desired state. The Agent validates a versioned candidate,
applies it atomically, verifies runtime health, and rolls back on failure. The
proxy data plane continues running when the panel or Agent is unavailable.

Node traffic terminology is explicit:

- `ownership`: `self` or `external`
- `management`: `agent` or `unmanaged`
- `traffic_reporting`: `trusted` or `unavailable`

Imported nodes default to external, unmanaged, and unavailable. Their traffic
must never be counted as physical host or self-hosted proxy traffic.

## Production support matrix

The managed runtime is supported on systemd Linux with amd64 or arm64.
Distribution and release-version allowlists are intentionally avoided: the
Agent validates the capabilities it actually depends on (systemd, architecture,
runtime binary validation, writable state directories, bindable ports, and a
supported firewall adapter) rather than rejecting otherwise compatible hosts.

## Security and delivery

- Each machine has an independent 256-bit credential.
- Existing global-key installations migrate on first successful authentication.
- Linux release binaries are musl builds and installation verifies SHA-256.
- Runtime configuration is private (`0700` directories, `0600` files).
- Proxy lifecycle tasks use a structured task type; they do not use shell text.

## Managed node port policy

Self-hosted nodes never assume that TCP/UDP 443 is available. The panel assigns
ports from the inclusive range `45654-55654` and stores the selected port as
part of the managed node's immutable deployment identity.

- Allocation is scoped to a server and excludes every port already assigned to
  another managed node on that server.
- The Agent must perform a local TCP or UDP bind preflight before applying the
  configuration. On collision it scans the configured range, atomically writes
  the selected port into the effective core configuration, applies it, and
  reports the final port to the panel. It must not replace or stop the occupying
  process.
- VLESS REALITY uses TCP and Hysteria2 uses UDP. The allocator nevertheless
  keeps numeric ports unique per server across both transports to simplify
  firewall rules, diagnostics, and subscription output.
- The Agent opens only the selected protocol and port through a supported host
  firewall adapter. It never replaces the host firewall policy wholesale.
- Subscription links and Mihomo/sing-box output use the actual allocated port;
  no renderer may silently substitute 443.
- Imported external nodes retain their supplied ports and are not affected by
  this policy.

## Provenance

Architecture research referenced Xboard and Xboard-Node publicly documented
behaviour. No source code is copied. New implementation uses API Monitor's own
domain model, interfaces, names, tests, and storage layout.

References:

- https://github.com/cedar2025/Xboard
- https://github.com/cedar2025/Xboard-Node
- https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
- https://sing-box.sagernet.org/installation/package-manager/
- https://sing-box.sagernet.org/configuration/inbound/vless/
- https://sing-box.sagernet.org/configuration/inbound/hysteria2/
- https://sing-box.sagernet.org/configuration/shared/tls/
- https://xtls.github.io/en/config/api.html
