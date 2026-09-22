# Balans API.
#
# A Dockerfile rather than a buildpack, for one reason: this service renders
# invoices through a real headless Chrome (F20, so the PDF and the web page
# come from one template and cannot drift apart). Every Node buildpack ships
# without a browser, and the ones that can add one put it at a path inside a
# package store that changes when the toolchain does. A container pins both the
# browser and where it lives.
#
# There is no build step. Node strips the types at load, which is why the whole
# of src/ is copied as it is and `engines` pins 22.6 — on an older Node this
# fails at boot, on the first .ts import, with an error that never mentions the
# version.

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    # The renderer looks here first. Without it, it falls through a list of
    # guesses and reports "no Chrome or Chromium found" on a machine that has
    # one.
    CHROME_PATH=/usr/bin/chromium

# Chromium, plus fonts. The fonts are not optional: without them Chrome falls
# back to a default that has no ₦, and every amount on every invoice renders as
# a box. DejaVu carries it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-dejavu-core \
        fonts-liberation \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a change to src/ does not reinstall them. `npm ci`
# rather than `install`, so the lockfile is what is built and a deploy cannot
# quietly pick up a different version than the one that was tested.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Chrome runs with --no-sandbox, which is why this must not be root: the
# sandbox is the thing that would otherwise contain a bad render, and running
# as root removes the container's own last line of defence as well.
USER node

# Overridden by the platform. Named so `docker run -p 4000:4000` works without
# anybody having to go and read config.ts.
ENV PORT=4000
EXPOSE 4000

CMD ["npm", "start"]
