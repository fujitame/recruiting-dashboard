# Campaign draft review without scheduling

The preparation drawer now saves an English subject/body, Japanese review translation, source links and a confirmation state. Saving never creates a delivery, touches Gmail labels or changes campaign execution flags. Date input is optional and collapsed. Existing replied-school, recipient, shared-address and immutable reserved-message guards remain in the original draft RPC.

Translations bind to the exact English source. Editing English marks the translation stale and clears confirmation. After updating the Japanese text, explicitly confirm correspondence and then mark content reviewed. Review metadata uses per-message optimistic revisions; English and translation updates share a database transaction so a stale translation revision rolls back both changes.

The list can filter missing drafts, missing translations, stale translations, saved unreviewed drafts and reviewed content. Shared-address saves copy the draft and review metadata atomically.

The preview escapes arbitrary content, preserves meaningful line breaks, bolds only the two player fact lines and both arrow labels, and leaves URLs at normal weight. Applying the same formatting to the production send worker is deferred; no send-worker deployment is included in this change.

Verification: formatter/review state tests; actual-module save integration with null planned date; shared-recipient version payload; stale save preservation; existing campaign/old activity isolation tests. Database transaction checks cover owner isolation, review persistence, translation conflict rollback and stale confirmation. Browser preview uses synthetic data only.
