# OpenAI Experiments

Rust app for experimenting with OpenAI's Responses API, specifically for combining images and text.

## Setup

1. Copy `.env.example` to `.env`:

   ```
   cp .env.example .env
   ```

2. Add your OpenAI API key to `.env`:

   ```
   OPENAI_API_KEY=sk-...
   ```

3. Build and run:
   ```
   cargo run
   ```

## Usage

Edit `main.rs` to configure:

- **Model**: Change `"gpt-4o"` to another model
- **Text prompts**: Modify the text in `build_response_request()` or `build_text_only_request()`
- **Images**: Add paths to the `sample_images` vector (relative to project root or absolute paths)

The app will:

1. List available models from your account
2. Show the text-only request structure
3. If images are configured, send a combined text+image request and print the response

## Key Functions

- `build_response_request()` - Builds request with text + multiple images
- `build_text_only_request()` - Simple text-only request for comparison
- `call_responses_api()` - Makes the actual API call
- `ImageInput::from_file()` - Loads an image file and converts to base64

## Dependencies

- `reqwest` - HTTP client for API calls
- `serde` / `serde_json` - JSON serialization
- `base64` - Image encoding
- `image` - Image processing (optional, for future use)
- `tracing` - Logging
- `dotenv` - Environment variable loading
