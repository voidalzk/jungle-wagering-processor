FROM oven/bun:1.4.4
WORKDIR /app
RUN chown bun:bun /app
USER bun
COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY --chown=bun:bun . .
RUN bun run build
EXPOSE 3000
CMD ["bun", "dist/main.js"]
