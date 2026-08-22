# cmd.exe rather than bare `bash`: on Windows `just` resolves `bash` against PATH, and where WSL is
# installed that is the WSL launcher in System32 — a Linux environment with no Node in it. Every
# recipe below is a single command with no shell syntax, so the choice of shell does not matter as
# long as it is not silently the wrong operating system.
set windows-shell := ["cmd.exe", "/c"]

# Show available recipes
default:
    @just --list

# Install workspace dependencies
setup:
    pnpm install

# Format all sources
format:
    pnpm format

# Everything CI checks, in the order CI checks it
check: format-check type-check test build

# Fail if anything is unformatted, rather than rewriting it
format-check:
    pnpm format:check

# Type-check every workspace package
type-check:
    pnpm typecheck

# Run the unit and integration suites
test:
    pnpm test

# Build every workspace package
build:
    pnpm build

# Run the web app against the staged dataset (http://localhost:5173)
dev:
    pnpm dev

# Pull the published Oracle dataset into the web app so the site can serve it same-origin.
# Data collection is out of scope for this story: these artifacts are produced by the Oracle
# pipeline and consumed here read-only. Override the source with ORACLE_ORIGIN.
stage-data:
    pnpm --filter @roofing/web run stage

# Deploy the CDK stack to AWS (us-east-2)
deploy: build
    pnpm --filter @roofing/api exec cdk deploy --require-approval never

# Synthesize the CloudFormation template without deploying
synth:
    pnpm --filter @roofing/api exec cdk synth

# One-time CDK bootstrap for the target account/region
bootstrap:
    pnpm --filter @roofing/api exec cdk bootstrap
