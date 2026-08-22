set windows-shell := ["bash", "-euo", "pipefail", "-c"]
set shell := ["bash", "-euo", "pipefail", "-c"]

# Show available recipes
default:
    @just --list

# Install workspace dependencies
setup:
    pnpm install

# Format all sources
format:
    pnpm prettier --write .

# Lint all sources
lint:
    pnpm eslint .

# Type-check every workspace package
type-check:
    pnpm turbo typecheck

# Run the unit and integration suites
test:
    pnpm turbo test

# Build every workspace package
build:
    pnpm turbo build

# Deploy the CDK stack to AWS (us-east-2)
deploy: build
    pnpm --filter @roofing/api exec cdk deploy --require-approval never

# Synthesize the CloudFormation template without deploying
synth:
    pnpm --filter @roofing/api exec cdk synth

# One-time CDK bootstrap for the target account/region
bootstrap:
    pnpm --filter @roofing/api exec cdk bootstrap

# Pull the published Oracle dataset into the web app so the site can serve it same-origin.
# Data collection is out of scope for this story: these artifacts are produced by the Oracle
# pipeline and consumed here read-only.
stage-data ORACLE_ORIGIN='https://d3dix6yacibswc.cloudfront.net':
    mkdir -p apps/web/public/dataset
    curl -fsSL -o apps/web/public/dataset/query-table.parquet {{ORACLE_ORIGIN}}/dataset/query-table.parquet
    curl -fsSL -o apps/web/public/dataset/permit-table.parquet {{ORACLE_ORIGIN}}/dataset/permit-table.parquet
    curl -fsSL -o apps/web/public/dataset/run-ledger.json {{ORACLE_ORIGIN}}/dataset/run-ledger.json
    @ls -lh apps/web/public/dataset/
