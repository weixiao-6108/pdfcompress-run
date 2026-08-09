# ---------- Stage 1: build qpdf 12.3.2 from source ----------
# Debian Bookworm（node:18-slim 基础镜像）自带的 qpdf 11.3 不支持 --jpeg-quality，
# 而 v19.2 轻度压缩依赖该参数控制降幅，因此从源码编译安装 qpdf 12.3.2。
FROM node:18-slim AS qpdf-builder

ARG QPDF_VERSION=12.3.2

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     build-essential \
     cmake \
     ca-certificates \
     curl \
     libjpeg-dev \
     zlib1g-dev \
  && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL --retry 3 --retry-delay 5 \
    -o /tmp/qpdf.tar.gz \
    "http://deb.debian.org/debian/pool/main/q/qpdf/qpdf_${QPDF_VERSION}.orig.tar.gz" \
  && tar xzf /tmp/qpdf.tar.gz -C /tmp \
  && cd /tmp/qpdf-${QPDF_VERSION} \
  && cmake -S . -B build \
       -DCMAKE_BUILD_TYPE=Release \
       -DCMAKE_INSTALL_PREFIX=/usr/local \
  && cmake --build build -j$(nproc) \
  && cmake --install build \
  && cd / \
  && rm -rf /tmp/qpdf-${QPDF_VERSION} /tmp/qpdf.tar.gz \
  && qpdf --version

# ---------- Stage 2: runtime ----------
FROM node:18-slim

# 安装运行时依赖和核心工具
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     ghostscript \
     poppler-utils \
     fonts-wqy-zenhei \
     fonts-wqy-microhei \
     libjpeg62-turbo \
     zlib1g \
  && rm -rf /var/lib/apt/lists/*

# 拷贝第一阶段编译好的 qpdf（使用 native crypto provider，无额外运行时依赖）
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
