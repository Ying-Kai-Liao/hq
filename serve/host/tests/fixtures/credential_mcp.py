"""MCP fixture verifies secrets reach only the connector process."""
import json
import os
import sys
for line in sys.stdin:
    msg = json.loads(line)
    if 'id' not in msg:
        continue
    if os.environ.get('API_KEY') != 'test-private-key':
        print(json.dumps({'jsonrpc':'2.0','id':msg['id'],'error':{'message':'invalid key'}}),flush=True)
        continue
    result = {'protocolVersion':'2025-06-18','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}} if msg['method']=='initialize' else {'tools':[]}
    print(json.dumps({'jsonrpc':'2.0','id':msg['id'],'result':result}),flush=True)
