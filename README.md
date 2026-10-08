# Load Tracker

- **Live app:** https://load-tracker-18ce6.web.app
- **Hosting:** Firebase Hosting, auto-deployed from `main` by GitHub Actions (`.github/workflows/deploy.yml`). GitHub signs in to Google with Workload Identity Federation — no keys or passwords stored in the repo or in GitHub secrets.
- **Data:** Cloud Firestore under `users/{uid}/…` and uploaded documents in Firebase Storage under `users/{uid}/documents/…`, readable only by the signed-in owner, qtlee322@gmail.com (see `firestore.rules` and `storage.rules`)
- **Sign-in:** Google

## One-time setup

Open [Google Cloud Shell](https://shell.cloud.google.com) as qtlee322@gmail.com, upload `setup-deploy.sh` (or paste it), and run `bash setup-deploy.sh`. It lets this GitHub repo deploy to the `load-tracker-18ce6` Firebase project.

## Making changes

Edit `index.html` (or upload a new one on GitHub) and commit to `main`. GitHub publishes it to the live site in about a minute, along with `firestore.rules` and `storage.rules`.

## Files

| File | What it is |
|---|---|
| `index.html` | The whole app |
| `firestore.rules`, `storage.rules` | Who can read and write data and files (only you) |
| `firebase.json`, `.firebaserc` | Firebase project settings |
| `.github/workflows/deploy.yml` | Auto-deploy on push to `main` |
| `setup-deploy.sh` | One-time Google Cloud setup for auto-deploy |
