export DOCKER_HOST := unix:///var/run/docker.sock
REGISTRY   := harbor.local.narwhal.internal
REPO       := library/narwhal-portal
VERSION    := $(shell node -p "require('./package.json').version")
IMAGE      := $(REGISTRY)/$(REPO)
TAG_VER    := $(IMAGE):v$(VERSION)
TAG_LATEST := $(IMAGE):latest

.PHONY: build push login all

## 이미지 빌드 (버전 태그 + latest)
build:
	docker build \
		--build-arg BUILDKIT_INLINE_CACHE=1 \
		-t $(TAG_VER) \
		-t $(TAG_LATEST) \
		.
	@echo "Built: $(TAG_VER)"

## Harbor 로그인
login:
	docker login $(REGISTRY)

## 빌드된 이미지 푸시
push:
	docker push $(TAG_VER)
	docker push $(TAG_LATEST)
	@echo "Pushed: $(TAG_VER)"

## 빌드 + 푸시 한 번에
all: build push
