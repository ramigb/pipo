# Owner and remote access

A Pipo engine has one **owner**: the person who runs it. There are no roles or other users. The owner logs in to the dashboard. The `pipo` CLI on the engine's machine doesn't need a login, because reading the Pipo home already makes you the owner.

This is the default (`engine.auth: owner`). An engine with `engine.auth: open` has no login at all, which is fine only while it listens on `127.0.0.1` alone.

## First run

On its first start, an engine with no owner writes a one-time **setup code** to its log:

```text
2026-10-11T09:12:03.512Z INFO  [engine] no owner yet: open http://127.0.0.1:4747/ui/#/setup and enter the setup code K7QD-M2XP-9RWA-HT4C (or run pipo ui on this machine)
```

You can then create the owner in either of two ways:

- **Run `pipo ui`** on the engine's machine. It reads the code with the engine key and opens the setup page with the code filled in.
- **Open `/ui/#/setup`** yourself and copy the code from `<home>/logs/engine.log`, or from the terminal that started `pipod`.

The setup page asks for:

- the code
- a username
- a password (at least 10 characters)
- an optional email, used only for reset links

Until the owner exists, every API request from a browser gets `401` with code `owner_setup_required`. The setup code is the reason it's safe to expose a fresh engine: only someone who can read its log can claim it.

On a headless machine, you can create the owner from the CLI instead:

```sh
pipo owner reset --username ada          # asks for the password twice
```

## Logging in

The dashboard sends you to **Log in** whenever it gets a `401`, and takes you back to the page you were on afterwards.

**Sessions:**

- A session is a cookie (`pipo_session`, HttpOnly, SameSite=Strict, and Secure when `engine.public_url` is https).
- It lasts 14 days and is extended while you use it.
- Only a SHA-256 digest of it is stored, in `<home>/sessions.json` (mode 0600), so sessions survive an engine restart.

**Rate limiting.** Failed logins, setup codes and reset tokens are limited for each client address: five free tries, then a wait that doubles from 30 s up to 15 minutes. There is also a limit of 30 failures a minute in total. Over the limit, requests get `429` with `Retry-After`.

**⚙️ Settings → 👤 Owner** has:

- **Log out**, which ends this browser's session.
- **Log out everywhere**, which ends every session, this one included.
- **Change password**, which needs the current password and ends every other session.
- **Email**, with **Send test email** once mail is set up.

## The CLI and the engine key

The engine writes `<home>/engine.key` (mode 0600) when it starts. The CLI sends that key with every request (`Authorization: Bearer …`). So `pipo status`, `pipo start` and every other command work without a login, as long as you can read the home. Anything else that can read the file, such as a script running as you, can use the API the same way.

`pipo owner reset --rotate-key` replaces the key. The running engine picks up the new key within a couple of seconds.

## Forgot your password?

There are two ways to reset it.

**From the CLI.** Run this on the engine's machine. It needs no old password:

```sh
pipo owner reset                     # asks for the new password twice
printf '%s' "$NEW" | pipo owner reset --password-stdin
pipo owner                           # who the owner is, sessions, whether mail is set up
```

It writes `<home>/owner.json` directly, so it works whether the engine runs or not. It ends every dashboard session; a running engine notices on its next request.

**By email.** When `engine.mail` is set and the owner has an email address, the login page offers **Forgot your password?**.

- The engine emails a link to `<public_url>/ui/#/reset/<token>`. Without `public_url`, the link uses the loopback address.
- The link works once, for 30 minutes. At most three links are live at a time.
- The answer is the same whether or not the name matches, so the page doesn't reveal who the owner is.
- Choosing a new password ends every session and logs you in.

The email address isn't verified. Use **Send test email** after saving it, so a typo doesn't leave you without a way back. The CLI reset always works.

## Mail

Pipo has a small SMTP client of its own. Point it at your provider's SMTP server:

```yaml
engine:
  mail:
    host: smtp.example.com
    port: 587                          # 587: STARTTLS (the default); 465: TLS from the start
    user: pipo@example.com
    password: op://Pipo/smtp/password  # a reference (op:// or env:), never the password itself
    from: "Pipo <pipo@example.com>"
```

- **`secure`** is `starttls` by default, or `tls` on port 465. `none` (plain text) is allowed only for a relay on this machine, such as `host: 127.0.0.1`.
- **`password`** is resolved once, when the engine starts, as [secrets](secrets.md) are. Some providers need an app password here.
- **Leave out `user` and `password`** for a relay that needs no login.
- **If mail fails**, the engine still starts. The error is in the engine log and the dashboard says mail is off; reset with `pipo owner reset` meanwhile.

## Exposing the engine

By default the engine listens on `127.0.0.1` only. To reach it from other machines, listen on every interface and tell the engine its public URL:

```yaml
engine:
  host: 0.0.0.0                        # or :: for IPv6; the default is 127.0.0.1
  public_url: https://pipo.example.com
```

`pipo engine start --host 0.0.0.0` does the same for one start. The engine refuses to start on a non-loopback host if either of these holds:

- `engine.auth` is `open`
- `engine.public_url` is not set

With `public_url` set:

- **Host check.** The API, OAuth and MCP answer requests addressed to its host as well as to loopback names. Any other `Host` gets `403`, and so does an `Origin` that isn't the engine's own.
- **Links.** Reset links, the OAuth issuer and the MCP resource use it.
- **Cookies** are marked Secure when it's https.

The engine itself speaks plain HTTP. Put it behind a reverse proxy that terminates TLS, such as Caddy or nginx, and keep `host` at `127.0.0.1` if the proxy runs on the same machine. Rate limits are kept per client address, so behind a proxy every client shares one budget.

### Inputs from the network

An exposed engine doesn't expose every webhook along with it. A request to `/in/<pipeline>/…` counts as "from the network" when any of these holds:

- it comes from an address other than loopback
- it is addressed to a name other than loopback, such as `public_url`
- a proxy forwarded it (`X-Forwarded-For` or `Forwarded`)

Such a request reaches an http input only if that input has `auth` (a token header or an HMAC, see [Inputs](inputs.md)), or says it is public:

```yaml
input:
  via: http
  with:
    path: /signup
    public: true                       # take unauthenticated requests from the network
```

Otherwise the runner answers `403` with a hint. Requests from this machine are never affected.
