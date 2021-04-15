FROM node:14-alpine as yarn-install
WORKDIR /usr/src/app
# Install app dependencies
COPY package.json yarn.lock ./
RUN apk add -U --virtual build-dependencies bash git openssh python make g++
RUN yarn --frozen-lockfile --no-cache
# Runtime container with minimal dependencies
FROM node:14-alpine
WORKDIR /usr/src/app
COPY --from=yarn-install /usr/src/app/node_modules /usr/src/app/node_modules
# Bundle app source
COPY . .
RUN yarn build

EXPOSE 3000
CMD [ "yarn", "start:db_migrate"]
