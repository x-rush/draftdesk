"""Check scoped connectivity / validate a sample without storing it or calling a model."""
import json, os, sys, urllib.request, urllib.error, urllib.parse
def main():
    base=os.environ.get('DRAFTDESK_URL','http://127.0.0.1:5173').rstrip('/')
    u=urllib.parse.urlparse(base)
    if u.username or u.password or u.query or u.fragment or u.path not in ('','/'):
        raise SystemExit('Use a base origin without credentials or path.')
    if u.scheme!='https' and not (u.scheme=='http' and u.hostname in ('localhost','127.0.0.1','host.docker.internal')):
        raise SystemExit('Use HTTPS for a remote workspace.')
    token=os.environ.get('DRAFTDESK_TOKEN')
    if not token: raise SystemExit('Missing DRAFTDESK_TOKEN; do not put it in the task prompt.')
    value={'probe':True}
    if len(sys.argv)>1:
        with open(sys.argv[1],encoding='utf-8-sig') as stream: value=json.load(stream)
    raw=json.dumps(value,ensure_ascii=False).encode('utf-8')
    if len(raw)>1000000: raise SystemExit('Sample exceeds 1 MB.')
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self,*args,**kwargs): return None
    request=urllib.request.Request(base+'/api/v1/intake-check',data=raw,headers={'Content-Type':'application/json','Authorization':'Bearer '+token},method='POST')
    try:
        with urllib.request.build_opener(NoRedirect).open(request,timeout=30) as response: result=json.load(response)
    except urllib.error.HTTPError as error:
        if error.code==400:
            try:
                result=json.load(error)
                print(json.dumps({'ok':False,'errors':result.get('errors',[])},ensure_ascii=False));raise SystemExit(1)
            except ValueError: pass
        raise SystemExit('Preflight HTTP %s; check address/token/schema.' % error.code)
    except urllib.error.URLError: raise SystemExit('Connection failed; check the address from inside the agent environment.')
    print(json.dumps(result,ensure_ascii=False,indent=2))
if __name__=='__main__': main()
