# codehalter bootstrap assisted
FROM alpine:3.23

RUN apk update && apk add --no-cache \
        ca-certificates curl git sudo \
        bash shadow \
        go \
        npm \
        firefox-esr

RUN groupadd --gid 1000 dev \
    && useradd --uid 1000 --gid 1000 -m -s /bin/bash -G wheel dev \
    && echo "dev ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/dev \
    && install -d -o 1000 -g 1000 /home/dev/.config

ENV GOBIN=/usr/local/bin
ENV GOTOOLCHAIN=auto
RUN GOPROXY=direct go install github.com/tbocek/codehalter@latest

USER dev
