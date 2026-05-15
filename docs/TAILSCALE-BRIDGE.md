# Tailscale Bridge — Point Any Machine at the PX13

The most useful pattern for road-warriors with multiple devices: keep your
PX13 at home plugged in, expose its llama-server through Tailscale, and reach
it from anywhere with full 30B perf.

```
┌─────────────────┐    Tailscale     ┌──────────────────┐
│ Zenbook Duo     │ ◄────────────────► │ PX13 (at home)   │
│ (anywhere)      │   private mesh    │ llama-server     │
│ claude-smart    │   end-to-end      │ Qwen3-Coder-30B  │
│   --local       │   encrypted       │ 26-71 t/s gen    │
└─────────────────┘                   └──────────────────┘
       │                                       ▲
       ▼                                       │
   Looks like                            Doesn't care that
   localhost:8080                        you're on the road
   from CLI perspective
```

Works for any number of client machines. Same UX as local from each one.

---

## 1. Tailscale on both machines

If you don't already have Tailscale running:

**On Bazzite (both PX13 and Duo):**

```bash
# Tailscale is in the default Fedora repos
sudo rpm-ostree install tailscale
sudo systemctl reboot

# After reboot
sudo systemctl enable --now tailscaled
sudo tailscale up
# Follow the URL it prints to authenticate
```

Verify both machines are on your tailnet:

```bash
tailscale status
```

You should see both with private 100.x.y.z IPs.

---

## 2. Expose llama-server on the PX13's tailscale interface

Currently the systemd unit binds to `127.0.0.1` — localhost only. We need it
to also listen on the tailscale interface so the Duo can reach it.

**Option A: bind to all interfaces, firewall everything except tailscale**
(safest, most flexible)

Edit `~/.config/systemd/user/llama-server.service` on the PX13. Change:

```
--host 127.0.0.1
```

to:

```
--host 0.0.0.0
```

Then firewall it to tailscale only:

```bash
# Allow incoming on port 8080 only from tailscale interface
sudo firewall-cmd --permanent --zone=trusted --add-interface=tailscale0
sudo firewall-cmd --permanent --zone=public --remove-port=8080/tcp 2>/dev/null
sudo firewall-cmd --reload
```

Tailscale's interface name is `tailscale0`. Anything coming in there is
trusted because tailscale is end-to-end encrypted between authenticated
devices on your tailnet. Anything on `public` (your normal LAN/WAN
interfaces) gets port 8080 closed.

Restart the server:

```bash
systemctl --user daemon-reload
systemctl --user restart llama-server.service
```

**Option B: bind specifically to the tailscale IP** (more conservative,
slightly more brittle)

```bash
# Find your PX13's tailscale IP
tailscale ip -4
# e.g. 100.64.1.5
```

Then in the systemd unit:

```
--host 100.64.1.5
```

The downside: if your tailscale IP changes (unlikely but possible), the
service stops listening.

**Use Option A.** It's also what you want if you ever spin up additional
clients (work laptop, phone via tailscale, etc.).

---

## 3. Find the PX13's tailscale address

From the Duo (or any other tailscale client):

```bash
tailscale status | grep px13
# Or just:
tailscale ip -4 <hostname-of-px13>
```

Record the 100.x.y.z address.

You can also use the MagicDNS name (e.g. `bazzite-proart` if MagicDNS is
enabled on your tailnet — check Tailscale admin panel).

---

## 4. Configure claude-smart on the client (Duo)

Edit `~/.local/bin/claude-smart` on the Duo. Change:

```bash
LOCAL_URL="http://127.0.0.1:8080"
```

to either:

```bash
LOCAL_URL="http://100.64.1.5:8080"           # tailscale IP
# or
LOCAL_URL="http://bazzite-proart:8080"        # MagicDNS name
```

Also update the model name so status output makes sense:

```bash
LOCAL_MODEL="qwen3-coder-30b"
```

(Even though the Duo isn't running the model directly, claude-smart needs
to set this env var when calling `claude`.)

---

## 5. Disable the Duo's local llama-server if you set one up

If you previously set up CPU inference on the Duo following
[`ZENBOOK-DUO.md`](ZENBOOK-DUO.md), now you don't need it running unless you
want a deeper fallback. Either:

```bash
# Stop, keep for emergency offline use
systemctl --user stop llama-server.service
systemctl --user disable llama-server.service
```

Or remove entirely if you'll always have internet → Tailscale → PX13:

```bash
systemctl --user stop llama-server.service
systemctl --user disable llama-server.service
rm ~/.config/systemd/user/llama-server.service
```

---

## 6. Test from the Duo

```bash
# Check the PX13 is reachable
curl -s http://bazzite-proart:8080/health
# → {"status":"ok"}

claude-smart --status
# → Anthropic API: up
# → Local (PX13):  up @ http://bazzite-proart:8080

claude-smart --local
# Cold-start prefill ~2 min, then snappy
```

---

## 7. Now what?

This setup unlocks a few useful patterns:

**The "good wifi" mode.** On hotel/cafe wifi with adequate latency to your
home, `claude-smart --local` is genuinely fast — Tailscale adds ~30-80ms but
that's invisible relative to inference time. Full 30B experience anywhere.

**The "no wifi" mode.** Tailscale can't reach the PX13 without internet on
both ends. If you're truly offline (long-haul flight), the Duo falls back
to its local CPU 7B per [`ZENBOOK-DUO.md`](ZENBOOK-DUO.md), if you kept it
configured.

**Three-tier strategy.** Edit `claude-smart` to add another tier:

```bash
# In claude-smart, add a probe for the PX13 specifically:
probe_px13() {
  curl -fsS --max-time 5 "http://bazzite-proart:8080/health" >/dev/null 2>&1
}
```

Then in the auto-mode dispatch, try in order:
1. Anthropic API
2. PX13 via Tailscale
3. Local CPU 7B

That's the platinum config: cloud, then your beast at home, then last-resort
local.

---

## 8. Security notes

- Tailscale traffic is encrypted with WireGuard — safe over any network
- The firewall change above (Option A) keeps port 8080 closed to your local
  LAN at home; only tailscale interface is trusted
- If you have multiple users on your tailnet (family, etc.), use Tailscale
  ACLs to limit who can reach the PX13's port 8080. Admin panel → Access
  controls.
- No API key on the local server — anyone on your tailnet with the IP can
  use your PX13's compute. That's fine for solo use, less fine for shared
  tailnets.

---

## 9. Cost / battery on the road

When using the PX13 via Tailscale from the Duo:

- **Duo battery**: minimal hit. Just network I/O and rendering the chat.
  Same as using Anthropic's API. Hours of work on battery.
- **PX13 power**: ~50-80 W during active inference, idle ~15 W. Keep it
  plugged in at home. Fine to leave running 24/7.
- **Tailscale data**: negligible. JSON over HTTP, a few MB per heavy session.

This is the best of both worlds — heavy compute stays at home where power
is free and unlimited; the road machine stays cool and battery-efficient.
