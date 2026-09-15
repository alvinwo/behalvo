# Review and release

Inspect the complete branch diff against its intended base and map it back to the
approved scope. Confirm that security boundaries and documentation describe only
implemented behavior. Review verification summaries and raw logs; do not infer a
pass from a success-looking line when the recorded exit code, signal, or final
summary says otherwise.

When review tools are available and the current session authorizes agent
delegation for a release, request two independent model reviews at `high` effort.
Give each reviewer the base, branch, scope, and repository guidance. Check every
finding against the source and tests, apply supported fixes with behavior tests
where applicable, then rerun the final verification. If review tools are absent,
record that limitation; their absence is not review evidence. A review does not
expand permission to publish or perform external writes.

Before an authorized merge or release, verify the exact commit, clean or explained
working-tree state, local verification evidence, and hosted CI state. Report live
acceptance only when it was actually performed; never promote scripted or offline
evidence into a readiness claim.
