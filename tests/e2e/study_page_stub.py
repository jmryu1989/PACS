"""Browser-only paged response for owned synthetic rows; never writes server data."""
from urllib.parse import urlsplit,parse_qs
def fulfill_page(route,items,owner):
    rows=sorted(items,key=lambda row:row['uid'])
    query=parse_qs(urlsplit(route.request.url).query)
    if 'limit' not in query:
        route.fulfill(status=200,json={'studies':rows});return
    offset=int(query.get('after',['0'])[0]);limit=int(query['limit'][0])
    route.fulfill(status=200,json={'studies':rows[offset:offset+limit], 'pagination':{
        'owner':owner,'limit':limit,'offset':offset,'total':len(rows),'next':str(offset+limit) if offset+limit<len(rows) else None}})
