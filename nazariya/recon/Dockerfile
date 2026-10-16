# GPU reconstruction worker image. Build on the GPU machine:  docker build -t nazariya-recon recon/
# Base: the official nerfstudio image (CUDA, COLMAP, gsplat, splatfacto). Pin a digest for production.
ARG NS_IMAGE=ghcr.io/nerfstudio-project/nerfstudio:latest
FROM ${NS_IMAGE}
COPY run.sh /usr/local/bin/nazariya-recon
RUN chmod +x /usr/local/bin/nazariya-recon
ENTRYPOINT ["/usr/local/bin/nazariya-recon"]
