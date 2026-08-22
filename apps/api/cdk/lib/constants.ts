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

/** Powertools service name, shared by every Lambda in this project. */
export const SERVICE_NAME = 'roofing-crm';

/** CloudWatch namespace for all custom metrics emitted by this project. */
export const METRICS_NAMESPACE = 'RoofingCrm';

/**
 * SSM SecureString holding the Anthropic API key.
 *
 * Created out of band rather than by this stack: CloudFormation cannot create a SecureString, and
 * routing the value through a template parameter would defeat the point by placing it in the
 * template. Scoped to this project rather than shared with the Oracle stack so the repository
 * stands alone — clone it, create the parameter, deploy. Create it once with:
 *
 *   aws ssm put-parameter --name /roofing-crm/anthropic-api-key \
 *     --type SecureString --value "<key>" --overwrite
 */
export const ANTHROPIC_KEY_PARAMETER = '/roofing-crm/anthropic-api-key';

/**
 * Daily ceiling on agent model calls.
 *
 * The endpoint is unauthenticated by design, so this is what bounds spend. At Haiku 4.5 pricing
 * with a capped output, this stays well under a dollar a day even if fully consumed.
 */
export const AGENT_DAILY_CALL_LIMIT = 200;
