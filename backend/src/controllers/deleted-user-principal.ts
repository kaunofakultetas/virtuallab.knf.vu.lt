// -----------------------------------------------------------
//  [*] Controllers — the deleted-account principal
//
//  The `users.vu_id` a departing account's audit rows are
//  reattributed to.
//
//  `network_reconciliation_attempts.requested_by` is a
//  foreign key to `users` with ON DELETE RESTRICT, and
//  nothing in the codebase ever deletes those rows — so any
//  user who provisioned an isolated VM owns some, and
//  deleting them was impossible. Worse, the deletion path
//  destroyed their VMs BEFORE reaching that constraint, so
//  the failure left an account with nothing to own and a
//  still-valid session.
//
//  Deleting the attempt rows instead would be the wrong
//  trade: they are the audit trail, and the reconciliations
//  they record really did happen. Repointing keeps the
//  history and is honest about who is left to answer for it.
//
//  The row is created by the schema alongside the table, so
//  the target always exists.
//
//  Used by:
//    - users.controller.ts — Users.delete
// -----------------------------------------------------------

export const DELETED_USER_PRINCIPAL = "deleted-user";
