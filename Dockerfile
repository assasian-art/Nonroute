FROM node:22.22.2-bookworm-slim

ENV NODE_ENV=production
ENV PORT=10000
ENV HOSTNAME=0.0.0.0
ENV DATA_DIR=/var/data/omniroute
ENV OMNIROUTE_DATA_DIR=/var/data/omniroute
WORKDIR /app

# Only the OmniRoute runtime is used by this container. Avoid installing
# unrelated wrapper dependencies (Express, pg, http-proxy and node-cron).
COPY package.json /tmp/nonroute-package.json
RUN node -e 'const fs=require("node:fs"); const p=require("/tmp/nonroute-package.json"); fs.writeFileSync("/app/package.json", JSON.stringify({private:true,type:"module",dependencies:{omniroute:p.dependencies.omniroute}})+"\\n")' \
    && npm install --prefix /app --omit=dev --no-audit --no-fund \
    && rm -f /tmp/nonroute-package.json

# The runtime is shipped by the npm package; repository sources/docs are not
# needed in the final image.
EXPOSE 10000
CMD ["node", "node_modules/omniroute/bin/omniroute.mjs"]
