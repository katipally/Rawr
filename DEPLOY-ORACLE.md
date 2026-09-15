# Deploying to Oracle Cloud (Always Free)

Render's Hobby workspace suspends on billing once the 5GB/month bandwidth grant
runs out. Oracle's Always Free tier gives an Ampere VM with 4 OCPU / 24GB and
10TB/month outbound at no ongoing cost, which is the point of moving here: not
cheaper bandwidth, bandwidth that does not run out on a normal month.

Nothing about the app changes. Same image, same `Dockerfile`, same environment
variables described in `DEPLOY.md` — this file covers only what is specific to
getting a Docker container running on a bare Oracle VM instead of a host that
already speaks Docker natively.

## Sign-up gives you two things, not one

```
 30-day / $300 trial credit    spend it on anything, reclaimed at day 30
                               if not upgraded to Pay As You Go
 Always Free resources         never expire, survive the trial ending,
                               continue at $0 whether or not you upgrade
```

The VM shapes this deploy needs (Ampere `VM.Standard.A1.Flex`, up to 2 OCPU /
12GB) are in the Always Free bucket. The trial credit is a separate bonus on
top, useful for the capacity workaround below — it is not what makes hosting
free, and letting it run out does not suspend anything Always Free.

Pick the home region carefully at sign-up. Always Free compute can only be
provisioned in your home region, and the region cannot be changed on the same
account afterward.

## The Ampere capacity problem

`VM.Standard.A1.Flex` is the most-requested free shape everywhere, and most
regions — this deploy hit it in `us-sanjose-1` — return `Out of capacity for
shape VM.Standard.A1.Flex` on most attempts. This is a real, common, and
unpredictable shortage, not a configuration mistake. It can clear in minutes or
take days.

Two ways through it:

**Keep retrying the free shape.** Lower the request to 1 OCPU / 6GB rather than
maxing out 2/12 — smaller requests succeed more often — and resize up once it's
running, or once capacity is less contested. No cost either way.

**Bridge on a paid x86 shape funded by the trial credit**, get the site back up
immediately, and move to the free Ampere shape later once it provisions. This is
what this deploy actually did, using `VM.Standard.E5.Flex` at 1 OCPU / 6GB
(`VM.Standard.E4.Flex` was tried first and was also out of capacity — E5 is the
newer generation, worth trying first if E4 stalls).

List pricing for a small x86 shape is a few cents an hour — a 1 OCPU/6GB
instance left running the full trial period costs roughly $25–30 of the $300
credit, not the whole thing. Upgrading to Pay As You Go (required to launch a
paid shape at all) puts a temporary ~$100 authorization hold on the card to
verify it, which reverses; it is not a charge. Nothing charges the card for real
unless total spend crosses $300 or Always Free limits are exceeded — Oracle's
own Budgets feature only sends alert emails at a threshold, it does not enforce
a hard cap, so the actual safeguard is terminating the paid bridge instance once
migrated to Ampere rather than leaving it running.

## Creating the instance

Console → Compute → Instances → Create Instance.

**Image**: Canonical Ubuntu 24.04. Not Oracle Linux — same free cost either way,
but Ubuntu's `apt`-based Docker install has far more generic documentation than
Oracle Linux's `dnf` + `firewalld`/SELinux defaults, which add friction for no
benefit on a plain container host.

**Shape**: Ampere `VM.Standard.A1.Flex`, sized up to 2 OCPU / 12GB (the Always
Free cap) once capacity allows — or the x86 bridge shape from above if not.

**Security**: enable Shielded instance (Secure Boot, Measured Boot, TPM). Free,
no downside for a plain web app, and irreversible only in the sense that you
cannot toggle it off after launch without recreating the instance. Note: this
toggle does not always stick through to Review — check the Review screen shows
Secure Boot / Measured Boot / TPM as Enabled before clicking Create, and re-edit
the Security step if it reset to Disabled.

**Networking**: on a brand-new tenancy there is no VCN yet. Selecting "Select
existing virtual cloud network" here dead-ends — the subnet dropdown is empty
and "Automatically assign public IPv4 address" stays permanently disabled with
no way to enable it, because no public subnet exists to assign from.

Instead choose **"Create new virtual cloud network"**, which also switches the
subnet to "Create new public subnet." Even then, "Automatically assign public
IPv4 address" can stay greyed out because the subnet is only a form value at
that point, not a created object yet — the reliable fix is to create the
network ahead of time: Networking → Virtual Cloud Networks → Start VCN Wizard →
**"Create VCN with Internet Connectivity"** (not the plain "Create VCN," which
skips the internet gateway and route table). Then back in instance creation,
select that VCN and its public subnet as *existing* resources, at which point
the public IP toggle behaves normally.

**Storage**: leave the default boot volume (~46GB) and in-transit encryption on.
No block volumes — the database and file storage are both external, on Supabase,
so this VM holds no persistent data of its own.

**SSH keys**: let the console generate a key pair and download the private key
immediately — it is shown once.

## Networking after launch

Two independent firewalls block traffic by default, and both need opening:

**Oracle's Security List** (cloud-level): instance page → Networking tab →
click the subnet → Default Security List → Add Ingress Rules. Add one rule each
for TCP port 80 and TCP port 443, source `0.0.0.0/0`.

**The VM's own iptables** (OS-level): passing the Security List does nothing if
Ubuntu's own firewall still drops the packet. Over SSH:

```
 sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
 sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
 sudo apt install -y iptables-persistent
```

`iptables-persistent`'s installer prompts to save current rules — accept both
IPv4 and IPv6 prompts, or the rules vanish on the next reboot.

## Connecting and installing Docker

```
 chmod 400 ~/.ssh/<downloaded-key>.key
 ssh -i ~/.ssh/<downloaded-key>.key ubuntu@<public-ip>
```

**`docker.io`, Ubuntu's own package, is not enough.** It does not include the
`buildx` or `compose` plugins — those exist only in Docker's official apt repo.
Installing `docker.io` alongside a non-existent `docker-compose-plugin` package
name fails the entire `apt install` command silently (apt is all-or-nothing),
which then makes the next step's `usermod -aG docker` fail with "group 'docker'
does not exist" — a confusing error whose actual cause is the earlier install
never happening at all.

Skip straight to Docker's official repository rather than starting with
`docker.io`:

```
 sudo apt update
 sudo apt install -y ca-certificates curl
 sudo install -m 0755 -d /etc/apt/keyrings
 sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
 sudo chmod a+r /etc/apt/keyrings/docker.asc

 sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
 Types: deb
 URIs: https://download.docker.com/linux/ubuntu
 Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
 Components: stable
 Architectures: $(dpkg --print-architecture)
 Signed-By: /etc/apt/keyrings/docker.asc
 EOF

 sudo apt update
 sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin git
 sudo usermod -aG docker $USER
```

Log out and back in for the group change to take effect (`exit`, then reconnect
over SSH), then confirm with `docker ps` before continuing — an EACCES-free,
error-free empty container list means it's working.

If `docker ps` instead says it cannot connect to the daemon, the service isn't
running — this can happen after removing `docker.io` mid-setup:

```
 sudo systemctl start docker
 sudo systemctl enable docker
```

## Building the image

```
 git clone https://github.com/katipally/Rawr.git
 cd Rawr
```

From a second terminal on your own machine, copy the environment file over —
**`.env.production`, not `.env.local`**. `.env.local` carries dev-only keys
(`RAWR_DEV_*` overrides, the Render-specific `RENDER` flag) that do not belong
on a production host, and is missing production-only ones `.env.production` has
(`PUBLIC_BASE_URL`, `TRUSTED_PROXY_HOPS`, `DATABASE_POOL_MAX`,
`RAWR_VISITOR_ACCOUNT`). Check `PUBLIC_BASE_URL` inside it points at wherever
this deploy is actually reachable from before copying it over, not a leftover
Render URL.

```
 scp -i ~/.ssh/<downloaded-key>.key /path/to/Rawr/.env.production ubuntu@<public-ip>:~/Rawr/.env.production
```

Back over SSH, inside `~/Rawr`, unquote it the same way `DEPLOY.md` describes
for any Docker host:

```
 sed 's/^\([A-Z_]*\)="\(.*\)"$/\1=\2/' .env.production > .env.docker
```

**The build needs BuildKit explicitly.** The Dockerfile's dependency-install
steps use `RUN --mount=type=cache`, which the plain legacy builder does not
support even with the buildx plugin now installed — it has to be told to use
it:

```
 DOCKER_BUILDKIT=1 docker build -t rawr .
```

## Migrating and running

**The migration needs to run as root, not the image's default user.** The
Dockerfile's final `USER node` line exists to keep the long-running web server
process from running as root — a real security measure — but it also means the
`node` user cannot write anywhere under `/repo`, including the temp file
`pnpm`'s dependency check creates when `pnpm db:migrate` runs. This surfaces as
`EACCES: permission denied, open '/repo/_tmp_...'`. Override the user for this
one-off task only; the actual server container should not carry this override:

```
 docker run --user root --env-file .env.docker rawr pnpm db:migrate
```

Then start the real container, on the image's normal non-root user — and
override the default `CMD` to run `scripts/both.mjs` rather than the web
server alone, or the background worker (scheduled jobs, integration syncs)
never starts:

```
 docker run -d --restart unless-stopped -p 3000:3000 --env-file .env.docker --name rawr rawr node scripts/both.mjs
```

Confirm it's alive from inside the VM first — `curl localhost:3000/healthz`
should return `{"ok":true,...}` — before testing externally, since an external
failure at that point could be either the app or the still-closed firewall on
port 3000, and testing locally first tells you which.

## Open question: fixing this in the image itself

The `EACCES` above is arguably a gap between the Dockerfile and what
`DEPLOY.md` documents — `DEPLOY.md` shows the plain `pnpm db:migrate` command
with no `--user root` override, implying it should work unmodified. A `chown`
to the `node` user before the final `USER node` line in the Dockerfile would
likely close this gap for every future deploy, not just this one — worth doing,
but it's a real code change to the image, not something to make silently.

## DNS, HTTPS, and OAuth

Oracle gives a public IP and nothing else — no free subdomain the way Render
gives every service a `*.onrender.com` URL. A real domain is needed to get a
working TLS certificate and, separately, because Google OAuth generally
refuses a bare IP as an authorized redirect URI for anything but a localhost
client.

**DNS**: at the registrar (Spaceship, in this deploy — same idea anywhere
else), add an A record for the root domain and one for `www`, both pointing at
the instance's public IP. Confirm it has actually propagated before touching
Caddy:

```
 dig +short yourdomain.com
```

If this doesn't print the VM's IP yet, wait — Caddy's automatic certificate
request will fail its domain-ownership check against stale DNS.

**Caddy**, for automatic HTTPS, installed from its own apt repo for the same
reason as Docker — Ubuntu's default repo lags:

```
 sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
 curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
 curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
 sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
 sudo chmod o+r /etc/apt/sources.list.d/caddy-stable.list
 sudo apt update
 sudo apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```
 yourdomain.com, www.yourdomain.com {
     reverse_proxy localhost:3000
 }
```

```
 sudo systemctl reload caddy
```

Caddy requests and renews the Let's Encrypt certificate itself on first
request to the domain — no certbot step. `sudo systemctl status caddy` should
show `active (running)`; the log lines mentioning `tls.obtain` and
`"certificate obtained successfully"` confirm it worked.

Port 3000 was opened earlier only to test the app directly before Caddy
existed. Close it back up now that Caddy is the real public entry point, both
at the OS level and in the OCI console's Default Security List:

```
 sudo iptables -D INPUT -p tcp --dport 3000 -j ACCEPT
 sudo netfilter-persistent save
```

**Point the app at the real domain.** `.env.production` still carries the
Render URL in three places from before the move — `AUTH_URL` and
`PUBLIC_BASE_URL` need to become the new domain, and `RAWR_INTERNAL_URL`
should be cleared entirely rather than repointed: per `DEPLOY.md`, that
variable is only for when the app and worker run on separate hosts, and here
they're one container behind Caddy, same as the Render setup was.

```
 AUTH_URL="https://yourdomain.com"
 PUBLIC_BASE_URL="https://yourdomain.com"
```

Re-copy, rebuild the env file, and restart the container with the updated
values:

```
 scp -i ~/.ssh/<downloaded-key>.key .env.production ubuntu@<public-ip>:~/Rawr/.env.production
```
```
 cd ~/Rawr
 sed 's/^\([A-Z_]*\)="\(.*\)"$/\1=\2/' .env.production > .env.docker
 docker stop rawr && docker rm rawr
 docker run -d --restart unless-stopped -p 3000:3000 --env-file .env.docker --name rawr rawr node scripts/both.mjs
```

**Google OAuth still points at Render until told otherwise.** Google Cloud
Console → APIs & Services → Credentials → the OAuth client → Authorized
redirect URIs → add `https://yourdomain.com/api/auth/google/callback`. Sign-in
redirects to Render regardless of where the app is actually running until this
is added — `AUTH_URL` controls what the app *sends* Google, but Google still
has to have that exact URL allow-listed on its side.

## Cleaning up the bridge instance

If an x86 shape was used to get online while waiting on Ampere capacity: once
Rawr is confirmed running well on the free Ampere instance, terminate the paid
one. Its cost is small, but it is the only thing standing between this deploy
and the trial credit running down for no reason — nothing in Oracle's billing
stops it automatically.
