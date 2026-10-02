# BOS Deploy entrypoint. Uses the upstream prebuilt image (building from source
# needs ~8 GB RAM) and runs the scheduled-job loops from docker-compose's
# `cron` service inside the same container.
FROM ghcr.io/elie222/inbox-zero:latest
COPY bos/start.sh /app/bos-start.sh
USER root
RUN chmod +x /app/bos-start.sh
EXPOSE 3000
CMD ["/app/bos-start.sh"]
