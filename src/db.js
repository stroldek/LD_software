export async function recordAudit(db, action, entityType = null, entityId = null, details = {}) {
  await db.prepare('INSERT INTO audit_log (action,entity_type,entity_id,details_json) VALUES (?,?,?,?)').bind(action,entityType,entityId === null ? null : String(entityId),JSON.stringify(details)).run();
}
export function buildLeadFilters(url) {
  const clauses=[]; const values=[]; const p=url.searchParams; const q=p.get('q')?.trim();
  if(q){clauses.push('(telegram_id LIKE ? OR username LIKE ? OR first_name LIKE ? OR last_name LIKE ?)');const t='%'+q.slice(0,100)+'%';values.push(t,t,t,t);}
  for(const key of ['status','quality','source']){const v=p.get(key);if(v){clauses.push(key+' = ?');values.push(v.slice(0,200));}}
  const from=p.get('from');const to=p.get('to');if(from){clauses.push('created_at >= ?');values.push(from);}if(to){clauses.push('created_at <= ?');values.push(to);}
  const sid=p.get('segment_id');if(sid&&/^\\d+$/.test(sid)){clauses.push('EXISTS (SELECT 1 FROM lead_segments ls WHERE ls.lead_id=leads.id AND ls.segment_id=?)');values.push(Number(sid));}
  return {where:clauses.length?'WHERE '+clauses.join(' AND '):'',values};
}
