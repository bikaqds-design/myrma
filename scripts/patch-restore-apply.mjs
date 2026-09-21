// One-off generator used to build the tail of 20260876_server_audit_log.sql.
// Takes the live rma_restore_apply body (extracted from the production-generated
// baseline) and adds the three audit lines, failing loudly if an anchor moved.
import { readFileSync, appendFileSync } from 'node:fs'

const [bodyFile, migrationFile] = process.argv.slice(2)
let body = readFileSync(bodyFile, 'utf8').trimEnd()

function insertAfter(anchor, addition) {
  const at = body.indexOf(anchor)
  if (at < 0 || body.indexOf(anchor, at + 1) >= 0) {
    throw new Error(`anchor not found exactly once: ${anchor}`)
  }
  const end = at + anchor.length
  body = body.slice(0, end) + addition + body.slice(end)
}
function insertBefore(anchor, addition) {
  const at = body.indexOf(anchor)
  if (at < 0 || body.indexOf(anchor, at + 1) >= 0) {
    throw new Error(`anchor not found exactly once: ${anchor}`)
  }
  body = body.slice(0, at) + addition + body.slice(at)
}

insertBefore(
  '  FOREACH v_table IN ARRAY public.rma_restore_manifest() LOOP',
  "  -- (20260876) One summary row per table below instead of one per row.\n" +
    "  PERFORM set_config('rma.audit_suspended', 'on', true);\n\n"
)
insertAfter(
  '    v_tables := v_tables + 1;\n',
  "    INSERT INTO public.audit_log (table_name, action, actor_email, actor_role, new_row) -- (20260876)\n" +
    "    VALUES (v_table, 'R', coalesce(public.rma_current_user_email(), session_user), auth.jwt() ->> 'role',\n" +
    "            jsonb_build_object('session', p_session, 'rows_written', v_n, 'rows_attempted', jsonb_array_length(v_rows)));\n"
)
insertBefore(
  '  DELETE FROM public.restore_staging WHERE session_id = p_session;\n  RETURN',
  "  PERFORM set_config('rma.audit_suspended', 'off', true); -- (20260876)\n"
)

appendFileSync(migrationFile, '\n' + body + '\n')
console.log('appended patched rma_restore_apply')
