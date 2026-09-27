# G-15 Non-production Observability Catalog

This catalog freezes the Phase 1A diagnostic vocabulary introduced through Ticket 16. It is operational documentation, not an SLA or a production monitoring contract.

## Stable HTTP and Worker diagnostic codes

The owning Ticket remains authoritative for request context and retry semantics. Names already frozen by the public seams include:

- Transport and authentication: `route_not_found`, `request_body_invalid`, `request_too_large`, `request_content_type_invalid`, `query_parameter_invalid`, `authentication_required`, `invalid_credentials`, `csrf_rejected`, `correlation_id_required`, `project_not_found`, `user_not_found`, `project_owner_membership_immutable`, `http_error`, `infrastructure_unavailable`, `dependency_unavailable`, `integrity_blocked`.
- Upload identity: `idempotency_key_required`, `idempotency_conflict`, `idempotency_in_progress`, `idempotency_resource_gone`, `asset_too_large`, `asset_upload_interrupted`.
- Asset and parsing: `asset_not_found`, `asset_not_ready`, `unsupported_asset_format`, `invalid_encoding`, `invalid_parser_config`, `invalid_parse_exclusion`, `parsed_view_not_found`, `parsed_view_not_draft_eligible`, `parsed_view_not_selectable`, `source_record_not_found`, `source_record_limit_exceeded`.
- Attribution and classification: `source_attribution_incomplete`, `data_classification_not_allowed`, `origin_rejected`.
- Drafts, recipes, and mapping: `draft_not_found`, `draft_not_ready`, `draft_capacity_exceeded`, `draft_configuration_invalid`, `draft_base_version_invalid`, `draft_mapping_or_schema_missing`, `draft_lease_invalid`, `draft_lease_held`, `draft_revision_conflict`, `draft_takeover_confirmation_required`, `draft_write_precondition_required`, `draft_source_already_attached`, `draft_source_not_found`, `recipe_invalid`, `mapping_invalid`, `mapping_metadata_invalid`, `mapping_records_invalid`, `mapping_source_missing`, `mapping_type_interpretation_failed`, `unmapped_fields_invalid`, `duplicate_field_name`.
- Formal Schema and cases: `formal_schema_unsupported`, `schema_proposal_required`, `schema_proposal_stale`, `case_not_found`, `case_id_conflict`, `case_deleted_in_draft`, `member_not_found`, `member_exists`, `member_configuration_invalid`, `manual_reason_required`, `manual_case_schema_invalid`, `manual_case_metadata_invalid`, `item_metadata_invalid`, `duplicate_content_included`, `duplicate_content_requires_decision`, `duplicate_decision_invalid`, `requires_new_test_set`.
- Candidate and publication: `candidate_not_found`, `candidate_not_ready`, `candidate_empty`, `candidate_materialization_conflict`, `candidate_materialization_in_progress`, `candidate_validation_failed`, `candidate_item_count_exceeded`, `input_capacity_exceeded`, `items_capacity_exceeded`, `publication_capacity_exceeded`, `publication_candidate_drift`, `publication_candidate_identity_mismatch`, `publication_candidate_payload_hash_mismatch`, `publication_candidate_evidence_hash_mismatch`, `publication_item_count_mismatch`, `publication_item_content_hash_mismatch`, `publication_manifest_mismatch`, `publication_delivery_mismatch`, `publication_project_scope_mismatch`, `publication_version_degraded_by_deletion`, `publication_cancel_window_closed`, `publication_job_not_active`.
- Jobs, versions, delivery, and deletion: `job_not_found`, `job_already_finished`, `job_not_retryable`, `job_cancelled`, `job_lease_expired`, `version_not_found`, `version_description_required`, `version_not_eligible_for_default`, `default_reason_required`, `default_precondition_required`, `default_version_conflict`, `default_version_cannot_archive`, `lifecycle_command_conflict`, `test_set_not_found`, `delivery_not_found`, `delivery_not_downloaded`, `package_configuration_invalid`, `controlled_deletion_owner_required`, `deletion_event_not_found`, `deletion_job_missing`, `deletion_target_invalid`, `deletion_target_not_found`, `deletion_locked`, `deletion_not_confirmable`, `deletion_already_confirmed`, `deletion_cannot_be_cancelled`, `deletion_not_retryable`, `deletion_preview_stale`, `deletion_scope_mismatch`, `deletion_reason_invalid`, `archive_reason_invalid`.
- Transformation and lineage: `transformation_run_not_found`, `transformation_run_missing`, `transformation_run_incomplete`, `transformation_run_not_completable`, `transformation_input_invalid`, `transformation_output_invalid`, `transformation_output_already_registered`, `transformation_manifest_invalid`, `transformation_prompt_invalid`, `transformation_annotation_required`, `transformation_record_edge_missing`, `lineage_subject_invalid`, `lineage_subject_not_found`, `lineage_cycle`.

`transformation_prompt_invalid` is a historical stable identifier and is not a domain-terminology substitute for Input.

## Stable audit event names

`asset_upload_capacity_blocked`, `asset_upload_completed`, `asset_archived`, `asset_downloaded`, `parse_attempt_requested`, `parse_failed`, `parse_failures_excluded`, `parsed_view_capacity_blocked`, `parsed_view_selected`, `source_attribution_revised`, `draft_created`, `draft_capacity_blocked`, `draft_recipe_saved`, `draft_source_added`, `draft_source_mapping_saved`, `draft_source_removed`, `draft_lease_acquired`, `draft_lease_released`, `draft_lease_taken_over`, `manual_case_created`, `manual_case_revised`, `manual_case_deleted`, `candidate_materialization_requested`, `materialization_retry_requested`, `candidate_capacity_blocked`, `publication_requested`, `publication_retry_requested`, `test_set_version_published`, `publish_failed`, `test_set_default_selected`, `test_set_version_archived`, `package_generation_requested`, `package_generated`, `langfuse_csv_generated`, `delivery_downloaded`, `delivery_import_attested`, `project_membership_changed`, `job_cancel_requested`, `job_cancelled`, `job_retry_requested`, `job_retry_scheduled`, `job_lease_expired`, `job_failed`, `job_succeeded`, `transformation_run_registered`, `transformation_run_annotated`, `deletion_preview_created`, `deletion_confirmed`, `deletion_retry_requested`.

## Stable consistency findings

- `object_missing`
- `object_hash_mismatch`
- `marker_missing`
- `marker_hash_mismatch`
- `evidence_hash_mismatch`
- `manifest_count_mismatch`
- `version_member_count_mismatch`
- `manifest_hash_mismatch`
- `consistency_check_failed`
- `aged_orphan`

Findings contain opaque IDs, object references, hashes, counts, and timestamps only. They never contain raw records, Input content, credentials, sessions, filenames, source URLs, or business metadata.

## Minimum metrics

All names use the `agentbench_` prefix:

- `agentbench_queue_depth`
- `agentbench_oldest_queued_age_seconds`
- `agentbench_job_successes_total`
- `agentbench_job_failures_total`
- `agentbench_job_retries_total`
- `agentbench_stage_duration_seconds_count`
- `agentbench_stage_duration_seconds_sum`
- `agentbench_postgresql_health`
- `agentbench_minio_health`
- `agentbench_disk_usage_percent`
- `agentbench_hash_mismatches_total`
- `agentbench_orphan_count`

Allowed metric labels are bounded enumerations only: job `kind`, observed `stage`, job/status state, and process identity. Metric labels and log fields must not contain project IDs, opaque object IDs, filenames, source URLs, raw records, Input content, passwords, sessions, object-storage credentials, or future connection keys. Structured job logs may contain opaque IDs because they are access-controlled diagnostics; metrics remain enumeration-only.

## Non-production defaults

- Worker consistency scan cadence: 60 minutes. A scan is read-only and covers active database references, active Version member counts, and all staged-object pages.
- F-PERSISTENCE public fixture commands: `npm run persistence:create -- <state.json>` and `npm run persistence:verify -- <state.json>`. Each invocation appends a redacted JSONL observation transcript beside the state file (`<state.json>.transcript.jsonl`), or to `PERSISTENCE_TRANSCRIPT`; it records only synthetic IDs, hashes, statuses, counts, versions, software version, and timestamps. Restart and normal redeploy actions use the repository Compose services; the script never repairs background state.
- Orphan scan cadence and grace follow the existing Ticket 09 defaults.
- Health readiness checks PostgreSQL and MinIO independently.
- Dependency unavailability is reported as `unavailable`; metrics remain available with zero-valued measurements and dependency health gauges.
- Disk usage reports the local host filesystem percentage from the process mount namespace; it is not a MinIO or PostgreSQL volume-capacity guarantee.
- Stage durations are measured between Worker progress transitions and persisted in `job_stage_duration`.

## Non-production alert defaults

These are local operational review defaults only; they are not SLA, SLO, RPO, or RTO commitments and implement no alert-delivery system:

| Observation                   | Non-production review threshold      |
| ----------------------------- | ------------------------------------ |
| PostgreSQL or MinIO health    | unhealthy for 30 seconds             |
| Hash mismatch or orphan count | any value above zero                 |
| Disk use                      | above 80%                            |
| Queue depth                   | above 100 jobs                       |
| Oldest queued age             | above 300 seconds                    |
| Job failure increase          | any increase sustained for 5 minutes |
