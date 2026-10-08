#!/usr/bin/env bash
# One-time setup so GitHub Actions can deploy to Firebase without any stored keys.
# Run it in Google Cloud Shell (https://shell.cloud.google.com) signed in as qtlee322@gmail.com:
#   bash setup-deploy.sh
# Safe to run more than once.
set -euo pipefail

PROJECT=load-tracker-18ce6
PROJECT_NUMBER=757577143595
REPO=qtlee322/load-tracker
SA=github-deploy@$PROJECT.iam.gserviceaccount.com

gcloud config set project "$PROJECT"

echo "Turning on the Google APIs the deploy uses..."
gcloud services enable \
  iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com \
  cloudresourcemanager.googleapis.com serviceusage.googleapis.com \
  firebase.googleapis.com firebasehosting.googleapis.com firebaserules.googleapis.com \
  firestore.googleapis.com firebasestorage.googleapis.com storage.googleapis.com

echo "Creating the deploy account..."
gcloud iam service-accounts describe "$SA" >/dev/null 2>&1 || \
  gcloud iam service-accounts create github-deploy --display-name="GitHub deploy"

for role in roles/firebasehosting.admin roles/firebaserules.admin roles/firebase.viewer \
            roles/serviceusage.serviceUsageConsumer; do
  gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:$SA" \
    --role="$role" --condition=None --quiet >/dev/null
done

echo "Letting GitHub (only the $REPO repo) sign in as that account..."
gcloud iam workload-identity-pools describe github --location=global >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools create github --location=global --display-name="GitHub"

gcloud iam workload-identity-pools providers describe github-actions \
  --location=global --workload-identity-pool=github >/dev/null 2>&1 || \
  gcloud iam workload-identity-pools providers create-oidc github-actions \
    --location=global --workload-identity-pool=github --display-name="GitHub Actions" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
    --attribute-condition="assertion.repository == '$REPO'"

gcloud iam service-accounts add-iam-policy-binding "$SA" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$REPO" \
  --quiet >/dev/null

echo "Done. Re-run the 'Deploy to Firebase' workflow on GitHub (Actions tab) or push any change to main."
