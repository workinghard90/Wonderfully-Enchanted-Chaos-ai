# Windows installation

Install Python 3.10+ and enable its launcher. From the repository folder:

```powershell
py -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e .
.\.venv\Scripts\python.exe -m pip check
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
.\.venv\Scripts\wec-studio.exe
```

Open http://127.0.0.1:8765. Use `wec-studio.exe --help` for options.
No activation command or PowerShell execution-policy changes are required.

For a token-protected local session:

```powershell
$env:WEC_STUDIO_TOKEN = (& .\.venv\Scripts\python.exe -c "import secrets; print(secrets.token_urlsafe(32))")
.\.venv\Scripts\wec-studio.exe
```

Keep the generated token in a password manager; the dashboard asks for it and
stores it only in the current browser tab. Do not put it in source code or a
public frontend config. For a new shell, set it again from your password manager.

To store projects elsewhere:

```powershell
$env:WEC_DATA_DIR = "$env:USERPROFILE\Documents\WEC Studio Data"
.\.venv\Scripts\wec-studio.exe
```

Install FFmpeg/FFprobe separately for video commands. Ensure `ffmpeg -version`
and `ffprobe -version` succeed in a new PowerShell window; FFmpeg needs libx264,
AAC and the subtitles/libass filter. Run `.\.venv\Scripts\wec.exe doctor`.
Piper and ComfyUI/models are optional separate installations. No model download
occurs during package installation. Quote paths containing spaces. Manifest
paths may use forward slashes on Windows; relative paths start at the manifest's
folder. Caption handling copies to a safe temporary filename to avoid Windows
FFmpeg filter escaping problems.

For iPhone access use the same private VPN/HTTPS endpoint as the PC. Binding to
`--host 0.0.0.0` requires a token of at least 32 characters. Do not expose port
8765 or ComfyUI's port 8188 through router port forwarding. For Windows Firewall,
restrict access to the private network/VPN interface. No firewall rules are
changed by this app. See [deployment](DEPLOYMENT.md).

These commands and cross-platform code paths were reviewed in Linux. Actual
Windows execution is covered by the proposed GitHub Actions matrix and requires
its successful run; it was not locally tested on Windows.
