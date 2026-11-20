# Deploy (one small VM)

The brief puts deployment out of scope; the recruiter asked for a link. So this runs the
**same `docker-compose.yml`** on one VM. No Kubernetes and no CI. The point is a URL a
reviewer can open, not a production setup.

## 1. VM
Any Ubuntu 24.04 VM with **2 vCPU / 2–4 GB RAM**, e.g. AWS EC2 `t3.small` or Lightsail ($10–12/month).
Open inbound **TCP 22** (your IP only) and **TCP 80**.

## 2. Install Docker and start the stack
```bash
ssh ubuntu@<vm-ip>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
git clone https://github.com/princeron77/highlevel-bulk-stage-move.git && cd highlevel-bulk-stage-move
docker compose -f docker-compose.yml -f deploy/docker-compose.public.yml up -d --build
docker compose run --rm init node dist/scripts/seed.js large     # optional: the 500k workspace
```

## 3. Check
- `http://<vm-ip>/health` returns `{"status":"ok","db":"up"}`
- `http://<vm-ip>/docs` opens Swagger UI. Use workspace `b0000000-0000-4000-8000-000000000001`.

## Notes
- The override publishes the API on port 80 and stops publishing Postgres. **The database is
  never exposed to the internet.**
- There is no auth (out of scope per the brief), so anyone with the link can create jobs.
  Take the VM down after the review.
- Update: `git pull && docker compose -f docker-compose.yml -f deploy/docker-compose.public.yml up -d --build`.
