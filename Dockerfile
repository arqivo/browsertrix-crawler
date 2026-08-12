# Arqivo fork build/push:
#
#   Production (amd64, ECR):
#     docker buildx build --platform linux/amd64 -f Dockerfile -t arqivo-browsertrix-crawler .
#     docker tag arqivo-browsertrix-crawler:latest 851725346735.dkr.ecr.eu-central-1.amazonaws.com/arqivo-browsertrix-crawler:1.14.0
#     aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin 851725346735.dkr.ecr.eu-central-1.amazonaws.com
#     docker push 851725346735.dkr.ecr.eu-central-1.amazonaws.com/arqivo-browsertrix-crawler:1.14.0
#
#   Local dev (arm64), the tag HarvestService::browsertrixImageOptions() expects:
#     docker buildx build --platform linux/arm64 -f Dockerfile -t arqivo-browsertrix-crawler-1.14.0 .
#
ARG BROWSER_VERSION=1.91.175
ARG BROWSER_IMAGE_BASE=webrecorder/browsertrix-browser-base:brave-${BROWSER_VERSION}

FROM ${BROWSER_IMAGE_BASE}

LABEL org.opencontainers.image.vendor="Webrecorder <https://webrecorder.net/>"
LABEL org.opencontainers.image.documentation="https://crawler.docs.browsertrix.com/"

# set to 1 to minimize size for prod, but longer build time, otherwise faster build and rebuild but larger image
ARG MINIMIZE_IMAGE_SIZE=0

# needed to add args to main build stage
ARG BROWSER_VERSION

ENV GEOMETRY=1360x1020x16 \
    BROWSER_VERSION=${BROWSER_VERSION} \
    BROWSER_BIN=google-chrome \
    OPENSSL_CONF=/app/openssl.conf \
    VNC_PASS=vncpassw0rd! \
    DETACHED_CHILD_PROC=1

EXPOSE 9222 9223 6080

WORKDIR /app

ADD package.json yarn.lock /app/

# to allow forcing rebuilds from this stage
ARG REBUILD

# Download and format ad host blocklist as JSON
RUN mkdir -p /tmp/ads && cd /tmp/ads && \
    curl -vs -o ad-hosts.txt https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts && \
    cat ad-hosts.txt | grep '^0.0.0.0 '| awk '{ print $2; }' | grep -v '0.0.0.0' | jq --raw-input --slurp 'split("\n")' > /app/ad-hosts.json && \
    rm /tmp/ads/ad-hosts.txt

# when not minimizing image size, do install here so that source changes do not trigger a rebuild (faster build)
RUN if [ "$MINIMIZE_IMAGE_SIZE" != "1" ] ; then \
      yarn install --network-timeout 1000000 --frozen-lockfile; \
    fi

ADD tsconfig.json /app/
ADD src /app/src

# when not minimizing image size, do only compile here for faster build, otherwise do full install and clean up in one layer and reduce image size
RUN if [ "$MINIMIZE_IMAGE_SIZE" != "1" ] ; then \
      yarn run tsc; \
    else \
      yarn install --network-timeout 1000000 --frozen-lockfile && \
      yarn run tsc && \
      yarn install --production --frozen-lockfile --network-timeout 1000000 && \
      yarn cache clean && \
      rm -rf /root/.npm; \
    fi

ADD config/ /app/

ADD html/ /app/html/

ARG RWP_VERSION=2.4.6
ADD https://cdn.jsdelivr.net/npm/replaywebpage@${RWP_VERSION}/ui.js /app/html/rwp/
ADD https://cdn.jsdelivr.net/npm/replaywebpage@${RWP_VERSION}/sw.js /app/html/rwp/
ADD https://cdn.jsdelivr.net/npm/replaywebpage@${RWP_VERSION}/adblock/adblock.gz /app/html/rwp/adblock.gz

RUN chmod a+x /app/dist/main.js /app/dist/create-login-profile.js /app/dist/indexer.js && chmod a+r /app/html/rwp/*

RUN ln -s /app/dist/main.js /usr/bin/crawl; \
    ln -s /app/dist/main.js /usr/bin/qa; \
    ln -s /app/dist/create-login-profile.js /usr/bin/create-login-profile; \
    ln -s /app/dist/indexer.js /usr/bin/indexer;

RUN mkdir -p /app/behaviors

WORKDIR /crawls

# Our behaviors bundle replaces the stock one installed by yarn. Built from
# browsertrix-behaviors v0.12.3 + patches/0001-*.patch — see docs/ARQIVO-PATCHES.md
# for what they change and how to rebuild after an upstream sync. Without this,
# autoscroll never runs (upstream regression since behaviors 0.10.0).
COPY behaviors.js /app/node_modules/browsertrix-behaviors/dist/behaviors.js

# add brave/chromium group policies
RUN mkdir -p /etc/brave/policies/managed/
ADD config/policies /etc/brave/policies/managed/

ADD docker-entrypoint.sh /docker-entrypoint.sh
ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["crawl"]
