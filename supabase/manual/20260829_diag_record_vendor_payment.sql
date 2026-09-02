-- Diagnostic: what the signature actually renders as.
SELECT p.proname,
       p.pronargs,
       pg_get_function_identity_arguments(p.oid) AS identity_args,
       pg_get_function_arguments(p.oid)          AS full_args
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = 'record_vendor_payment';
