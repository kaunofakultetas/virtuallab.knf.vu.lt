/**
 * The `users.vu_id` a scheduled reconciliation attempt is recorded against.
 *
 * `network_reconciliation_attempts.requested_by` is a foreign key to `users`, so
 * a background job cannot simply write "system". Attributing it to an arbitrary
 * admin would be worse: the attempt log is the audit trail, and a change nobody
 * made must not appear under somebody's name.
 *
 * The row is created by the schema alongside the table, so the reconciler always
 * has a subject that is honest about being a machine.
 */
export const DRIFT_RECONCILER_PRINCIPAL = "system-drift-reconciler";
