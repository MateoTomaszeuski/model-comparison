# Open WebUI + Model Comparison

A self-hosted setup running [Open WebUI](https://github.com/open-webui/open-webui) alongside a custom Model Comparison tool. Send the same prompt to multiple LLMs side-by-side and compare their responses.

## Services

| Service | Port | Description |
|---------|------|-------------|
| Open WebUI | `localhost:3000` | Chat interface for LLMs |
| Model Comparison | `localhost:3001` | Side-by-side model comparison tool |
| Ollama | (internal) | Local model runner |

## Getting Started

### Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose

### Steps

1. **Clone the repo**

   ```sh
   git clone <repo-url>
   cd open-webui
   ```

2. **Start all services**

   ```sh
   docker compose up --build -d
   ```

3. **Create an Open WebUI account**

   Go to [localhost:3000](http://localhost:3000) and create a new account.

4. **Connect AI providers and/or pull Ollama models**

   In Open WebUI, go to **Settings → Connections** to add any AI provider you want (OpenAI, Anthropic, etc.). To use local models, pull them through Ollama:

   ```sh
   docker exec -it ollama ollama pull <model-name>
   ```

5. **Use the Model Comparison tool**

   Go to [localhost:3001](http://localhost:3001) and log in with the **same credentials** you created in Open WebUI. Select two or more models, enter a prompt, and compare their outputs side-by-side.

## Configuration

Ports and image tags can be customized via environment variables (or a `.env` file):

| Variable | Default | Description |
|----------|---------|-------------|
| `OPEN_WEBUI_PORT` | `3000` | Open WebUI port |
| `MODEL_COMPARE_PORT` | `3001` | Model Comparison tool port |
| `OLLAMA_DOCKER_TAG` | `latest` | Ollama image tag |
| `WEBUI_DOCKER_TAG` | `main` | Open WebUI image tag |
