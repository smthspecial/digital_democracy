#!/usr/bin/env python3
"""Local assisted-review adapter. Run only after reviewing synthetic evidence.

The private verifier key stays on the reviewer machine. Applicants cannot call
this through the web application. Grants are written to a new private file.
"""
import argparse
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]


def signed_headers(path, body, secret):
    timestamp, nonce = str(int(time.time())), secrets.token_hex(16)
    digest = hashlib.sha256(body).hexdigest()
    payload = f'identity-verifier\nPOST\n{path}\n{timestamp}\n{nonce}\n{digest}'
    signature = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return {'Content-Type': 'application/json', 'X-DD-Service': 'identity-verifier',
            'X-DD-Timestamp': timestamp, 'X-DD-Nonce': nonce, 'X-DD-Signature': signature}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('citizen_id', type=uuid.UUID)
    parser.add_argument('--method', choices=['national_id', 'passport', 'gov_credential'], default='national_id')
    parser.add_argument('--evidence-ref', help='Private reference to evidence already reviewed; never the raw identifier')
    parser.add_argument('--retry-grant', action='store_true', help='Retry delivery for an already verified identity')
    parser.add_argument('--output', type=Path, required=True, help='New private file for the five-minute enrollment grant')
    parser.add_argument('--env-file', type=Path, default=ROOT / '.env.local', help='Private local reviewer configuration')
    args = parser.parse_args()
    if not args.retry_grant and not args.evidence_ref:
        parser.error('--evidence-ref is required after reviewing evidence')
    config = args.env_file
    if config.stat().st_mode & 0o077:
        raise SystemExit('The local environment file must have mode 600')
    settings = dict(line.split('=', 1) for line in config.read_text().splitlines()
                    if line and not line.startswith('#') and '=' in line)
    secret = settings.get('IDENTITY_VERIFIER_SHARED_SECRET')
    if not secret:
        raise SystemExit('Local verifier credentials are not configured')
    port = int(settings.get('API_TS_PORT', '4000'))
    suffix = 'enrollment-grant' if args.retry_grant else 'verifications'
    path = f'/identity/citizens/{args.citizen_id}/{suffix}'
    body = json.dumps({} if args.retry_grant else {
        'method': args.method, 'evidenceRef': args.evidence_ref, 'outcome': 'verified',
    }, separators=(',', ':')).encode()
    # Reserve the destination before activating anything; never overwrite a
    # credential file or follow a symlink supplied as the output path.
    fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        request = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=body,
                                        headers=signed_headers(path, body, secret), method='POST')
        with client.open(request, timeout=15) as response:
            result = json.load(response)
        grant = result if args.retry_grant else result.get('enrollment', {})
        if not isinstance(grant.get('enrollment_grant'), str) or not grant['enrollment_grant']:
            raise ValueError('No enrollment grant was returned')
        with os.fdopen(fd, 'w') as stream:
            fd = None
            stream.write(grant['enrollment_grant'] + '\n')
        print(f'Enrollment grant saved privately to {args.output}. Use it within five minutes, then delete the file.')
    except (OSError, ValueError, urllib.error.URLError):
        if fd is not None:
            os.close(fd)
        args.output.unlink(missing_ok=True)
        raise SystemExit('Review or grant delivery failed. Check the citizen status; use --retry-grant if activation already succeeded.')


if __name__ == '__main__':
    main()
