FROM node:22-alpine AS build

WORKDIR /bot
ADD src/ /bot/src/
ADD package-lock.json package.json tsconfig.json /bot/
RUN npm install
RUN npx tsc

FROM node:22-alpine
WORKDIR /bot
COPY --from=build /bot/dist/ /bot/dist/
COPY --from=build /bot/node_modules/ /bot/node_modules/
COPY --from=build /bot/package.json /bot/package-lock.json /bot/
RUN npm prune --omit=dev
CMD ["node", "dist/index.js"]
