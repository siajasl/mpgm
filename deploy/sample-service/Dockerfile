# The sample service `release.deliver` ships (DEP-2, DEP-3; `contracts/release.deliver.md`).
#
# It exists to make a release observable: `APP_VERSION` bakes into the page
# it serves, so two releases of this same tree produce two images with
# different digests *and* visibly different running content — which is what
# lets a rollback be tested rather than merely asserted (this task's own
# completion criterion). Nothing about the shape is specific to `release.deliver`;
# it is deployed the same way the placeholder service in
# `deploy/environments/*/html/` is, via `MPGM_SERVICE_IMAGE` overriding a
# compose file's default (`env.provision`, DEP-1, DEP-4).
FROM nginx:1.27-alpine
ARG APP_VERSION=dev
RUN printf '<!doctype html>\n<html lang="en"><head><meta charset="utf-8" /><title>mpgm sample-service</title></head><body><p>mpgm sample-service %s</p></body></html>\n' "$APP_VERSION" \
    > /usr/share/nginx/html/index.html
