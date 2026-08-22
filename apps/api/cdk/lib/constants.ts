/**
 * Values fixed by `apply-engineering-guidelines` (cloud-aws-primary) or by this project's
 * naming scheme. Kept in one place so the stack, its tests, and the runbook cannot drift.
 */

/** Mandated primary region. Never inherit this from the caller's AWS profile. */
export const TARGET_REGION = 'us-east-2';

/** Cost-allocation tag applied to every resource in every stack. */
export const PROJECT_NAME = 'roofing-crm-arturas';

/** Stack name. Scoped by owner because several candidates deploy into shared accounts. */
export const STACK_NAME = 'RoofingCrm-Arturas';
