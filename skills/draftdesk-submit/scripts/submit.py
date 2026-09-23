"""Submit a validated research envelope; no dependencies, no secrets in output."""
import json, os, sys, urllib.request, urllib.error, urllib.parse

def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python submit.py result.json')
    base = os.environ.get('DRAFTDESK_URL', 'http://127.0.0.1:5173').rstrip('/')
    parsed = urllib.parse.urlparse(base)
    if parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise SystemExit('DRAFTDESK_URL must be a base origin without credentials/query/path.')
    if parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', 'host.docker.internal')):
        raise SystemExit('Use HTTPS for remote workspaces.')
    token = os.environ.get('DRAFTDESK_TOKEN')
    if not token:
        raise SystemExit('Set DRAFTDESK_TOKEN in your environment.')
    with open(sys.argv[1], encoding='utf-8-sig') as stream:
        value = json.load(stream)
    if value.get('schemaVersion') != '1.0' or not value.get('submissionId') or not value.get('evidence'):
        raise SystemExit('Missing schemaVersion, submissionId or evidence.')
    types = {'official','media','community','product','repository','trend','other'}
    for index, evidence in enumerate(value['evidence']):
        if evidence.get('sourceType') not in types:
            raise SystemExit('evidence[%s].sourceType must be one of: %s' % (index, ', '.join(sorted(types))))
        if evidence.get('contentLevel', 'excerpt') not in ('fulltext','excerpt','headline'):
            raise SystemExit('evidence[%s].contentLevel must be fulltext, excerpt or headline' % index)
    raw = json.dumps(value, ensure_ascii=False).encode('utf-8')
    if len(raw) > 1000000:
        raise SystemExit('Payload exceeds 1 MB.')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *args, **kwargs):
            return None
    request = urllib.request.Request(base + '/api/v1/intake', data=raw, headers={'Content-Type':'application/json','Authorization':'Bearer '+token}, method='POST')
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=45) as response:
            receipt = json.load(response)
            print(json.dumps(receipt, ensure_ascii=False, indent=2))
    except urllib.error.HTTPError as error:
        if error.code == 400:
            try:
                detail = json.load(error).get('error', '')
                if detail.startswith('数据格式不符合协议：'):
                    raise SystemExit('Submission rejected (HTTP 400): ' + detail[:800])
            except (ValueError, AttributeError):
                pass
        raise SystemExit('Submission rejected (HTTP %s). Check token or payload in DraftDesk.' % error.code)

if __name__ == '__main__':
    main()
