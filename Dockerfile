# v19.5 — 用自带 qpdf 12 的 Debian Trixie 基础镜像，彻底避免源码编译。
# 之前 v19.3/v19.4 反复在 CloudBase 构建器里 exit 127（卡在 cmake 编译链），
# 根因是 CloudBase 构建环境跑 cmake 源码编译不稳。本方案：
#   - debian:trixie-slim 自带 qpdf 12.2.0（>= 12.1.0，支持 --jpeg-quality），
#     用 apt 直接装，零编译、零下载、无 cmake/curl，从根上消除 127。
#   - 同时自带 nodejs 20 LTS，glibc 与 qpdf 一致，运行无兼容问题。
FROM debian:trixie-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       nodejs \
       npm \
       qpdf \
       ghostscript \
       poppler-utils \
       fonts-wqy-zenhei \
       fonts-wqy-microhei \
       libjpeg62-turbo \
       zlib1g \
       ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && qpdf --version

# 让 Ghostscript 能找到系统字体
ENV GS_FONTPATH=/usr/share/fonts

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
