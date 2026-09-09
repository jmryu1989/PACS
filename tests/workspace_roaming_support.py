"""Delete only this synthetic run's new workspace rows with full-row equality guards."""
import json,subprocess,uuid
def cleanup_workspace(stack, table='WorkspaceLayout'):
    if table not in ('WorkspaceLayout', 'WorklistColumns', 'ReadingPreferences', 'ReadingAppearance'):raise ValueError('Unsupported preference table')
    subjects=list(stack.user_ids.values())
    for sub in subjects:
        if str(uuid.UUID(sub))!=sub:raise RuntimeError('Invalid synthetic subject')
    if not subjects:return
    where=','.join("'"+s+"'" for s in subjects)
    def sql(query):return subprocess.check_output(['docker','exec','kin-db','psql','-XqAt','-v','ON_ERROR_STOP=1','-U','kin','-d','kin','-c',query]).decode().strip()
    rows=sql('SELECT to_jsonb(t)::text FROM "'+table+'" t WHERE subject IN ('+where+')').splitlines()
    for raw in rows:
        row=json.loads(raw)
        if row['subject'] not in subjects:raise RuntimeError('Foreign workspace row')
        print('ROAM synthetic row '+table+' '+raw,flush=True)
        result=sql('DELETE FROM "'+table+'" t WHERE to_jsonb(t)=\''+raw.replace("'","''")+'\'::jsonb RETURNING 1')
        if result!='1':raise RuntimeError('Synthetic workspace changed before exact-row cleanup')
    if sql('SELECT count(*) FROM "'+table+'" WHERE subject IN ('+where+')')!='0':raise RuntimeError('Workspace fixture remains')
    print('ROAM exact-row cleanup '+str(len(rows)),flush=True)
