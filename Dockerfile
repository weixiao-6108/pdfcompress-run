# ---------- Stage 1: build qpdf 12.3.2 from source (single RUN, native crypto) ----------
# 之前 v19.3 失败原因：多 RUN 分层 + cmake 编译链在 CloudBase 构建器里某条命令退出 127（命令找不到）。
# 改为「单条 RUN」一次性装依赖 + 下载 + 编译 + 安装 + 校验，杜绝分层/PATH 问题；
# 用 REQUIRE_CRYPTO_NATIVE=1 让 libqpdf 自带原生加密实现，运行时不再依赖 gnutls/openssl。
# Debian Bookworm（node:18-slim 基础镜像）自带 qpdf 11.3，不支持 --jpeg-quality（12.1.0 才加入），
# 因此源码编译 12.3.2。下载源带 github 备用，避免单一镜像源不可达。
FROM node:18-slim AS qpdf-builder

RUN set -e \
  && apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential \
       cmake \
       curl \
       ca-certificates \
       libjpeg-dev \
       zlib1g-dev \
  && rm -rf /var/lib/apt/lists/* \
  && ( curl -fsSL --retry 3 --retry-delay 5 -o /tmp/qpdf.tar.gz \
         "http://deb.debian.org/debian/pool/main/q/qpdf/qpdf_12.3.2.orig.tar.gz" \
     || curl -fsSL --retry 3 --retry-delay 5 -o /tmp/qpdf.tar.gz \
         "https://github.com/qpdf/qpdf/releases/download/v12.3.2/qpdf-12.3.2.tar.gz" ) \
  && tar xzf /tmp/qpdf.tar.gz -C /tmp \
  && cd /tmp/qpdf-12.3.2 \
  && cmake -S . -B build \
       -DCMAKE_BUILD_TYPE=Release \
       -DCMAKE_INSTALL_PREFIX=/usr/local \
       -DREQUIRE_CRYPTO_NATIVE=1 \
  && cmake --build build -j"$(nproc)" \
  && cmake --install build \
  && cd / \
  && rm -rf /tmp/qpdf-12.3.2 /tmp/qpdf.tar.gz \
  && qpdf --version

# ---------- Stage 2: runtime ----------
FROM node:18-slim

# 运行时只需 ghostscript/poppler/字体 + libjpeg/zlib（native crypto 无需额外加密库）
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ghostscript \
       poppler-utils \
       fonts-wqy-zenhei \
       fonts-wqy-microhei \
       libjpeg62-turbo \
       zlib1g \
  && rm -rf /var/lib/apt/lists/*

COPY --from=qpdf-builder /usr/local/bin/qpdf /usr/local/bin/qpdf
COPY --from=qpdf-builder /usr/local/lib/libqpdf.so* /usr/local/lib/
ENV LD_LIBRARY_PATH=/usr/local/lib

# 让 Ghostscript 能找到系统字体
ENV GS_FONTPATH=/usr/share/fonts

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY index.js ./

ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
