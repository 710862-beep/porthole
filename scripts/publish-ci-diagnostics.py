"""Expose build diagnostics through GitHub Checks annotations (no binary payloads).
The complete original logs remain in Actions artifacts. This bounded mirror lets
API-only clients diagnose builds without reaching Azure artifact redirect hosts.
"""
from pathlib import Path
import re

for path in (Path('artifacts/toolchain-install.log'), Path('artifacts/rebuild-wasm.log')):
    if not path.exists():
        continue
    text = path.read_text(errors='replace')
    # Never echo auth headers, cookies, or signed query parameters.
    text = re.sub(r'(?i)(authorization\s*[:=]\s*|cookie\s*:\s*|(?:token|sig|signature)=)[^\s&]+', r'\1[REDACTED]', text)
    limit = 240000
    if len(text) > limit:
        text = '[TRUNCATED: last 240000 characters; full log in artifact]\n' + text[-limit:]
    chunks = [text[i:i+3000] for i in range(0, len(text), 3000)]
    for index, chunk in enumerate(chunks):
        escaped = chunk.replace('%', '%25').replace('\r', '%0D').replace('\n', '%0A')
        print(f'::notice title=Porthole {path.name} {index+1}/{len(chunks)}::{escaped}')
