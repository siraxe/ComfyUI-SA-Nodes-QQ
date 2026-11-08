import os
import json
from aiohttp import web

from server import PromptServer
import folder_paths

from .utils import path_exists
from .utils_server import get_param, is_param_falsy
from .utils_info import delete_model_info, get_model_info, set_model_info_partial, get_file_info

routes = PromptServer.instance.routes


def _check_valid_model_type(request):
  model_type = request.match_info['type']
  if model_type not in ['loras', 'checkpoints']:
    return web.json_response({'status': 404, 'error': f'Invalid model type: {model_type}'})
  return None


@routes.get('/wanvid/api/{type}')
async def api_get_models_list(request):
  """Returns a list of model types from user configuration.

  By default, a list of filenames are provided. If `format=details` is specified, a list of objects
  with additional _file info_ is provided. This includes modigied time, hasInfoFile, and imageLocal
  among others.
  """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  files = folder_paths.get_filename_list(model_type)
  format_param = get_param(request, 'format')
  if format_param == 'details':
    response = []
    for file in files:
      response.append(get_file_info(file, model_type))
    return web.json_response(response)

  return web.json_response(list(files))


@routes.get('/wanvid/api/{type}/info')
async def api_get_models_info(request):
  """Returns a list model info; either all or a specific ones if provided a 'files' param.

  If a `light` param is specified and not falsy, no metadata will be fetched.
  """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  files_param = get_param(request, 'files')
  maybe_fetch_metadata = files_param is not None
  if not is_param_falsy(request, 'light'):
    maybe_fetch_metadata = False
  api_response = await models_info_response(
    request, model_type, maybe_fetch_metadata=maybe_fetch_metadata
  )
  return web.json_response(api_response)


@routes.get('/wanvid/api/{type}/info/refresh')
async def api_get_refresh_get_models_info(request):
  """Refreshes model info; either all or specific ones if provided a 'files' param. """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  api_response = await models_info_response(
    request, model_type, maybe_fetch_civitai=True, maybe_fetch_metadata=True
  )
  return web.json_response(api_response)


@routes.get('/wanvid/api/{type}/info/clear')
async def api_get_delete_model_info(request):
  """Clears model info from the filesystem for specific files only - no bulk clearing."""
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  api_response = {'status': 200}
  model_type = request.match_info['type']
  files_param = get_param(request, 'files')

  # Always require files parameter - no bulk clearing
  if not files_param:
    api_response['status'] = '400'
    api_response['error'] = 'Missing required parameter: files'
    return api_response

  files_param = files_param.split(',')
  del_info = not is_param_falsy(request, 'del_info')
  del_metadata = not is_param_falsy(request, 'del_metadata')
  del_civitai = not is_param_falsy(request, 'del_civitai')

  # Validate that files exist
  all_files = folder_paths.get_filename_list(model_type)
  valid_files = []
  for file_param in files_param:
    if file_param in all_files:
      valid_files.append(file_param)
    else:
      print(f"[Warning] File not found for clearing: {file_param}")

  if not valid_files:
    api_response['status'] = '404'
    api_response['error'] = 'No valid files found'
    return api_response

  # Clear info for only the specified files
  for file_param in valid_files:
    await delete_model_info(
      file_param,
      model_type,
      del_info=del_info,
      del_metadata=del_metadata,
      del_civitai=del_civitai
    )
  return web.json_response(api_response)


@routes.post('/wanvid/api/{type}/info')
async def api_post_save_model_data(request):
  """Saves data to a model by name. """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  api_response = {'status': 200}
  file_param = get_param(request, 'file')
  if file_param is None:
    api_response['status'] = '404'
    api_response['error'] = 'No model found at path'
  else:
    post = await request.post()
    await set_model_info_partial(file_param, model_type, json.loads(post.get("json")))
    info_data = await get_model_info(file_param, model_type)
    api_response['data'] = info_data
  return web.json_response(api_response)


@routes.get('/wanvid/api/{type}/img')
async def api_get_models_info_img(request):
  """ Returns an image response if one exists for the model. """
  if _check_valid_model_type(request):
    return _check_valid_model_type(request)

  model_type = request.match_info['type']
  file_param = get_param(request, 'file')
  file_path = folder_paths.get_full_path(model_type, file_param)
  if not path_exists(file_path):
    file_path = os.path.abspath(file_path)

  img_path = None
  for ext in ['jpg', 'png', 'jpeg']:
    try_path = f'{os.path.splitext(file_path)[0]}.{ext}'
    if path_exists(try_path):
      img_path = try_path
      break

  if not path_exists(img_path):
    api_response = {}
    api_response['status'] = '404'
    api_response['error'] = 'No model found at path'
    return web.json_response(api_response)

  return web.FileResponse(img_path)


@routes.get('/wanvid/api/loras/preview')
async def api_get_lora_preview_image(request):
  """Returns a preview image or JSON data from the _power_preview directory."""
  api_response = {'status': 200}

  try:
    # Get parameters
    file_param = get_param(request, 'file')
    subfolder_param = get_param(request, 'subfolder', '')
    suffix_param = get_param(request, 'suffix', '')  # Optional suffix parameter
    is_model_param = get_param(request, 'is_model', 'false').lower() == 'true'

    if not file_param:
      api_response['status'] = '400'
      api_response['error'] = 'Missing required parameter: file'
      return web.json_response(api_response)

    # Security: prevent directory traversal
    if '..' in file_param or '..' in subfolder_param:
      api_response['status'] = '400'
      api_response['error'] = 'Invalid file path'
      return web.json_response(api_response)

    # Get appropriate directory based on type
    if is_model_param:
      # For models, use checkpoints directory
      base_dir = folder_paths.get_folder_paths('checkpoints')[0]
      # Use _power_preview subdirectory for model previews
      power_preview_dir = os.path.join(base_dir, '_power_preview')
    else:
      # For LoRAs, use loras directory
      base_dir = folder_paths.get_folder_paths('loras')[0]
      power_preview_dir = os.path.join(base_dir, '_power_preview')

    # Construct the full path
    if subfolder_param:
      # Remove leading/trailing slashes from subfolder
      subfolder_param = subfolder_param.strip('/\\')
      search_dir = os.path.join(power_preview_dir, subfolder_param)
    else:
      search_dir = power_preview_dir

    # Check if this is a JSON file request
    if file_param.endswith('.json'):
      # Handle JSON file requests
      json_path = os.path.join(search_dir, file_param)

      if path_exists(json_path):
        # Security: ensure the file is within the power_preview directory
        if not os.path.abspath(json_path).startswith(os.path.abspath(power_preview_dir)):
          api_response['status'] = '403'
          api_response['error'] = 'Access denied'
          return web.json_response(api_response)

        # Read and return JSON content
        try:
          with open(json_path, 'r', encoding='utf-8') as f:
            json_data = json.load(f)
          return web.json_response(json_data)
        except json.JSONDecodeError as e:
          api_response['status'] = '500'
          api_response['error'] = f'Invalid JSON format: {str(e)}'
          return web.json_response(api_response)
        except Exception as e:
          api_response['status'] = '500'
          api_response['error'] = f'Error reading JSON file: {str(e)}'
          return web.json_response(api_response)
      else:
        api_response['status'] = '404'
        api_response['error'] = 'JSON file not found'
        return web.json_response(api_response)

    # Handle image files (existing logic)
    # Try different image extensions
    img_path = None

    # If suffix is specified, look for that specific file
    if suffix_param:
      for ext in ['jpg', 'jpeg', 'png']:
        try_path = os.path.join(search_dir, f"{file_param}{suffix_param}.{ext}")
        if path_exists(try_path):
          img_path = try_path
          break
    else:
      # Try suffixed images first (_01.jpg, _02.jpg, _03.jpg)
      for i in range(1, 4):  # Check for _01, _02, _03
        suffix = f"_{i:02d}"
        for ext in ['jpg', 'jpeg', 'png']:
          try_path = os.path.join(search_dir, f"{file_param}{suffix}.{ext}")
          if path_exists(try_path):
            img_path = try_path
            break
        if img_path:
          break

      # If no suffixed images found, try original image (backward compatibility)
      if not img_path:
        for ext in ['jpg', 'jpeg', 'png']:
          try_path = os.path.join(search_dir, f"{file_param}.{ext}")
          if path_exists(try_path):
            img_path = try_path
            break

    if not img_path:
      api_response['status'] = '404'
      api_response['error'] = 'Preview image not found'
      return web.json_response(api_response)

    # Security: ensure the file is within the power_preview directory
    if not os.path.abspath(img_path).startswith(os.path.abspath(power_preview_dir)):
      api_response['status'] = '403'
      api_response['error'] = 'Access denied'
      return web.json_response(api_response)

    return web.FileResponse(img_path)

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Server error: {str(e)}'
    return web.json_response(api_response)


@routes.get('/wanvid/api/loras/previews')
async def api_get_lora_previews_list(request):
  """Returns a list of LoRAs that have preview images available."""
  api_response = {'status': 200, 'previews': []}

  try:
    # Get parameters to determine if we're looking for models or LoRAs
    is_model_param = get_param(request, 'is_model', 'false').lower() == 'true'

    if is_model_param:
      # Handle models (use checkpoints directory)
      base_dir = folder_paths.get_folder_paths('checkpoints')[0]
      power_preview_dir = os.path.join(base_dir, '_power_preview')
      files_list = folder_paths.get_filename_list('checkpoints')
    else:
      # Handle LoRAs
      base_dir = folder_paths.get_folder_paths('loras')[0]
      power_preview_dir = os.path.join(base_dir, '_power_preview')
      files_list = folder_paths.get_filename_list('loras')

    if not path_exists(power_preview_dir):
      # Ensure directory exists if it doesn't
      os.makedirs(power_preview_dir, exist_ok=True)
      print(f"[Preview] Created directory: {power_preview_dir}")

    # Check each file for preview images
    for file_item in files_list:
      item_name = file_item
      # Remove extension
      for ext in ['.safetensors', '.pt', '.ckpt', '.bin']:
        if item_name.endswith(ext):
          item_name = item_name[:-len(ext)]
          break

      # Check for preview in various locations
      preview_found = False
      preview_paths = []

      # Check for suffixed preview images first (_01.jpg, _02.jpg, _03.jpg)
      found_suffixes = []
      for i in range(1, 4):  # Check for _01, _02, _03
        suffix = f"_{i:02d}"

        # Check root _power_preview directory
        for img_ext in ['jpg', 'jpeg', 'png']:
          preview_path = os.path.join(power_preview_dir, f"{item_name}{suffix}.{img_ext}")
          if path_exists(preview_path):
            preview_found = True
            relative_path = os.path.relpath(preview_path, base_dir)
            preview_paths.append(relative_path.replace('\\', '/'))
            found_suffixes.append(suffix)
            break

        # Check subfolders
        path_parts = item_name.replace('/', os.sep).replace('\\', os.sep).split(os.sep)
        if len(path_parts) > 1:
          subfolder = os.sep.join(path_parts[:-1])
          filename = path_parts[-1]

          subfolder_path = os.path.join(power_preview_dir, subfolder)
          if path_exists(subfolder_path):
            for img_ext in ['jpg', 'jpeg', 'png']:
              preview_path = os.path.join(subfolder_path, f"{filename}{suffix}.{img_ext}")
              if path_exists(preview_path):
                preview_found = True
                relative_path = os.path.relpath(preview_path, base_dir)
                preview_paths.append(relative_path.replace('\\', '/'))
                found_suffixes.append(suffix)
                break

      # If no suffixed images found, check for single image (backward compatibility)
      if not found_suffixes:
        # Check root _power_preview directory
        for img_ext in ['jpg', 'jpeg', 'png']:
          preview_path = os.path.join(power_preview_dir, f"{item_name}.{img_ext}")
          if path_exists(preview_path):
            preview_found = True
            relative_path = os.path.relpath(preview_path, base_dir)
            preview_paths.append(relative_path.replace('\\', '/'))
            break

        # Check subfolders if not found in root
        if not preview_found:
          # Look for subfolder structure
          path_parts = item_name.replace('/', os.sep).replace('\\', os.sep).split(os.sep)
          if len(path_parts) > 1:
            subfolder = os.sep.join(path_parts[:-1])
            filename = path_parts[-1]

            subfolder_path = os.path.join(power_preview_dir, subfolder)
            if path_exists(subfolder_path):
              for img_ext in ['jpg', 'jpeg', 'png']:
                preview_path = os.path.join(subfolder_path, f"{filename}.{img_ext}")
                if path_exists(preview_path):
                  preview_found = True
                  relative_path = os.path.relpath(preview_path, base_dir)
                  preview_paths.append(relative_path.replace('\\', '/'))
                  break

      if preview_found:
        api_response['previews'].append({
          'lora': file_item,  # Keep 'lora' key for backward compatibility
          'preview_paths': preview_paths,
          'type': 'model' if is_model_param else 'lora'
        })

    return web.json_response(api_response)

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Server error: {str(e)}'
    return web.json_response(api_response)


@routes.post('/wanvid/api/lora/preview-image')
async def api_save_lora_preview_image(request):
  """Save a preview image for a LoRA in the _power_preview directory."""
  import io
  from PIL import Image

  api_response = {'status': 200, 'message': 'Preview image saved successfully'}

  try:
    # Get form data
    post = await request.post()
    image_file = post.get('image')
    lora_name = post.get('lora_name')
    lora_path = post.get('lora_path', '')
    suffix = post.get('suffix', '')
    is_model = post.get('is_model', 'false').lower() == 'true'

    if not image_file or not lora_name:
      api_response['status'] = '400'
      api_response['error'] = 'Missing required parameters: image and lora_name'
      return web.json_response(api_response)

    # Get appropriate directory based on type
    if is_model:
      # For models, use checkpoints directory
      base_dir = folder_paths.get_folder_paths('checkpoints')[0]
      # Use _power_preview subdirectory for model previews
      power_preview_dir = os.path.join(base_dir, '_power_preview')
    else:
      # For LoRAs, use loras directory
      base_dir = folder_paths.get_folder_paths('loras')[0]
      power_preview_dir = os.path.join(base_dir, '_power_preview')

    if lora_path:
      save_dir = os.path.join(power_preview_dir, lora_path)
    else:
      save_dir = power_preview_dir

    # Ensure directory exists
    os.makedirs(save_dir, exist_ok=True)

    # Construct save path with optional suffix
    filename = f"{lora_name}{suffix}.jpg"
    save_path = os.path.join(save_dir, filename)

    # Read image data
    image_data = image_file.file.read()

    # Open with PIL, process, and save
    with Image.open(io.BytesIO(image_data)) as img:
      # Convert to RGB if necessary (for JPEG)
      if img.mode in ('RGBA', 'LA', 'P'):
        # Create white background for transparency
        background = Image.new('RGB', img.size, (255, 255, 255))
        if img.mode == 'P':
          img = img.convert('RGBA')
        if img.mode in ('RGBA', 'LA'):
          background.paste(img, mask=img.split()[-1] if img.mode == 'RGBA' else None)
          img = background
        else:
          img = img.convert('RGB')
      elif img.mode != 'RGB':
        img = img.convert('RGB')

      # Save as JPEG with high quality
      img.save(save_path, 'JPEG', quality=90, optimize=True)

    api_response['save_path'] = os.path.relpath(save_path, base_dir)
    api_response['file_size'] = os.path.getsize(save_path)
    api_response['filename'] = filename
    api_response['base_dir'] = base_dir

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Failed to save preview image: {str(e)}'
    print(f"[Preview Image Error] {str(e)}")

  return web.json_response(api_response)

@routes.get('/wanvid/api/proxy/image')
async def api_proxy_external_image(request):
  """Proxy an external image through the backend to avoid CSP violations."""
  import aiohttp

  api_response = {'status': 200}

  try:
    # Get the URL from query parameter
    url_param = get_param(request, 'url')

    if not url_param:
      api_response['status'] = '400'
      api_response['error'] = 'Missing required parameter: url'
      return web.json_response(api_response)

    # Security: only allow images from whitelisted domains
    allowed_domains = [
      'image.civitai.com',
      'civitai.com',
      'imagecache.civitai.com'
    ]

    from urllib.parse import urlparse
    parsed_url = urlparse(url_param)
    if parsed_url.netloc not in allowed_domains:
      api_response['status'] = '403'
      api_response['error'] = f'Domain not allowed: {parsed_url.netloc}'
      return web.json_response(api_response)

    # Fetch the external image
    timeout = aiohttp.ClientTimeout(total=30)
    async with aiohttp.ClientSession(timeout=timeout) as session:
      async with session.get(url_param) as response:
        if response.status != 200:
          api_response['status'] = str(response.status)
          api_response['error'] = f'Failed to fetch image: HTTP {response.status}'
          return web.json_response(api_response)

        # Get content type
        content_type = response.headers.get('Content-Type', 'image/jpeg')

        # Stream the image data back
        image_data = await response.read()
        return web.Response(body=image_data, content_type=content_type)

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Server error: {str(e)}'
    return web.json_response(api_response)


@routes.get('/wanvid/api/proxy/video-frame')
async def api_proxy_video_frame(request):
  """Extract a frame from an external video URL and return it as an image."""
  import aiohttp
  import io

  api_response = {'status': 200}

  try:
    # Get the URL from query parameter
    url_param = get_param(request, 'url')
    time_param = get_param(request, 'time', '50')  # Default to 50% (middle)

    if not url_param:
      api_response['status'] = '400'
      api_response['error'] = 'Missing required parameter: url'
      return web.json_response(api_response)

    # Security: only allow videos from whitelisted domains
    allowed_domains = [
      'image.civitai.com',
      'civitai.com',
      'imagecache.civitai.com'
    ]

    from urllib.parse import urlparse
    parsed_url = urlparse(url_param)
    if parsed_url.netloc not in allowed_domains:
      api_response['status'] = '403'
      api_response['error'] = f'Domain not allowed: {parsed_url.netloc}'
      return web.json_response(api_response)

    # Fetch the external video
    timeout = aiohttp.ClientTimeout(total=60)  # Longer timeout for videos
    async with aiohttp.ClientSession(timeout=timeout) as session:
      async with session.get(url_param) as response:
        if response.status != 200:
          api_response['status'] = str(response.status)
          api_response['error'] = f'Failed to fetch video: HTTP {response.status}'
          return web.json_response(api_response)

        # Read video data into memory
        video_data = await response.read()

    # Extract frame using opencv or fallback method
    try:
      # Try using opencv-python first
      import cv2
      import numpy as np

      # Write video data to temporary file
      import tempfile
      with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_file:
        temp_file.write(video_data)
        temp_path = temp_file.name

      try:
        # Open video file
        cap = cv2.VideoCapture(temp_path)

        if not cap.isOpened():
          raise Exception("Failed to open video file")

        # Get video properties
        frame_count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        fps = cap.get(cv2.CAP_PROP_FPS)

        # Calculate target frame position (middle by default)
        time_pct = float(time_param) / 100.0
        target_frame = int(frame_count * time_pct)

        # Seek to target frame
        cap.set(cv2.CAP_PROP_POS_FRAMES, target_frame)

        # Read the frame
        ret, frame = cap.read()

        if not ret or frame is None:
          # Fallback to first frame
          cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
          ret, frame = cap.read()

        cap.release()

        if not ret or frame is None:
          raise Exception("Failed to extract frame from video")

        # Convert frame to JPEG bytes
        is_success, buffer = cv2.imencode(".jpg", frame)
        if not is_success:
          raise Exception("Failed to encode frame")

        frame_bytes = buffer.tobytes()

        return web.Response(body=frame_bytes, content_type='image/jpeg')

      finally:
        # Clean up temp file
        try:
          os.unlink(temp_path)
        except:
          pass

    except ImportError:
      # opencv not available, try PIL/Pillow with imageio
      try:
        import imageio.v3 as iio
        import tempfile

        # Write to temp file
        with tempfile.NamedTemporaryFile(suffix='.mp4', delete=False) as temp_file:
          temp_file.write(video_data)
          temp_path = temp_file.name

        try:
          # Read video and extract frame
          video_frames = iio.imread(temp_path, index=None, mode='I')

          if video_frames is None or len(video_frames) == 0:
            raise Exception("No frames in video")

          # Get middle frame
          frame_idx = len(video_frames) // 2 if hasattr(video_frames, '__len__') else 0
          frame = video_frames[frame_idx]

          # Convert to PIL Image and save as JPEG
          from PIL import Image
          if isinstance(frame, iio.core.util.Image):
            img = Image.fromarray(frame)
          else:
            img = Image.fromarray(frame)

          output = io.BytesIO()
          img.save(output, format='JPEG', quality=90)
          frame_bytes = output.getvalue()

          return web.Response(body=frame_bytes, content_type='image/jpeg')

        finally:
          try:
            os.unlink(temp_path)
          except:
            pass

      except ImportError:
        api_response['status'] = '500'
        api_response['error'] = 'No video processing library available (opencv-python or imageio required)'
        return web.json_response(api_response)

    except Exception as e:
      api_response['status'] = '500'
      api_response['error'] = f'Failed to extract video frame: {str(e)}'
      return web.json_response(api_response)

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Server error: {str(e)}'
    return web.json_response(api_response)


@routes.post('/wanvid/api/model/preview-json')
async def api_save_model_preview_json(request):
  """Save JSON data for a model preview in the _power_preview/_model_preview directory."""

  api_response = {'status': 200, 'message': 'Model preview JSON saved successfully'}

  try:
    # Get form data
    post = await request.post()
    json_data = post.get('json')
    model_name = post.get('model_name')
    model_path = post.get('model_path', '')

    if not json_data or not model_name:
      api_response['status'] = '400'
      api_response['error'] = 'Missing required parameters: json and model_name'
      return web.json_response(api_response)

    # Get checkpoints directory as base
    checkpoints_dir = folder_paths.get_folder_paths('checkpoints')[0]
    # Use _power_preview subdirectory for model previews
    power_preview_dir = os.path.join(checkpoints_dir, '_power_preview')
    print(f"[Model JSON Debug] Using directory: {power_preview_dir}")

    if model_path:
      save_dir = os.path.join(power_preview_dir, model_path)
    else:
      save_dir = power_preview_dir

    # Ensure directory exists
    os.makedirs(save_dir, exist_ok=True)
    print(f"[Model JSON Debug] Directory ensured: {save_dir}")
    print(f"[Model JSON Debug] Directory exists check: {os.path.exists(save_dir)}")

    # Parse and validate JSON data
    try:
      json_content = json.loads(json_data)
    except json.JSONDecodeError as e:
      api_response['status'] = '400'
      api_response['error'] = f'Invalid JSON format: {str(e)}'
      return web.json_response(api_response)

    # Construct save path - the JSON filename should have a trailing underscore
    # to match the image naming convention (e.g., model_name_.json for model_name_01.jpg)
    json_filename = f"{model_name}_.json"
    save_path = os.path.join(save_dir, json_filename)

    # Save JSON file
    with open(save_path, 'w', encoding='utf-8') as f:
      json.dump(json_content, f, indent=2, ensure_ascii=False)

    api_response['save_path'] = os.path.relpath(save_path, checkpoints_dir)
    api_response['filename'] = json_filename
    api_response['base_dir'] = checkpoints_dir

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Failed to save model preview JSON: {str(e)}'
    print(f"[Model Preview JSON Error] {str(e)}")

  return web.json_response(api_response)


@routes.post('/wanvid/api/lora/preview-json')
async def api_save_lora_preview_json(request):
  """Save JSON data for a LoRA preview in the _power_preview directory."""

  api_response = {'status': 200, 'message': 'LoRA preview JSON saved successfully'}

  try:
    # Get form data
    post = await request.post()
    json_data = post.get('json')
    lora_name = post.get('lora_name')
    lora_path = post.get('lora_path', '')

    if not json_data or not lora_name:
      api_response['status'] = '400'
      api_response['error'] = 'Missing required parameters: json and lora_name'
      return web.json_response(api_response)

    # Get loras directory
    loras_dir = folder_paths.get_folder_paths('loras')[0]
    # Use _power_preview directory for LoRA previews
    power_preview_dir = os.path.join(loras_dir, '_power_preview')

    if lora_path:
      save_dir = os.path.join(power_preview_dir, lora_path)
    else:
      save_dir = power_preview_dir

    # Ensure directory exists
    os.makedirs(save_dir, exist_ok=True)

    # Parse and validate JSON data
    try:
      json_content = json.loads(json_data)
    except json.JSONDecodeError as e:
      api_response['status'] = '400'
      api_response['error'] = f'Invalid JSON format: {str(e)}'
      return web.json_response(api_response)

    # Construct save path - the JSON filename should have a trailing underscore
    # to match the image naming convention (e.g., lora_name_.json for lora_name_01.jpg)
    json_filename = f"{lora_name}_.json"
    save_path = os.path.join(save_dir, json_filename)

    # Save JSON file
    with open(save_path, 'w', encoding='utf-8') as f:
      json.dump(json_content, f, indent=2, ensure_ascii=False)

    api_response['save_path'] = os.path.relpath(save_path, loras_dir)
    api_response['filename'] = json_filename
    api_response['base_dir'] = loras_dir

  except Exception as e:
    api_response['status'] = '500'
    api_response['error'] = f'Failed to save LoRA preview JSON: {str(e)}'
    print(f"[LoRA Preview JSON Error] {str(e)}")

  return web.json_response(api_response)


async def models_info_response(
  request, model_type, maybe_fetch_civitai=False, maybe_fetch_metadata=False
):
  """Gets model info for specific files only - no bulk processing allowed."""
  api_response = {'status': 200, 'data': []}
  light = not is_param_falsy(request, 'light')
  files_param = get_param(request, 'files')

  # Always require files parameter - no bulk processing
  if not files_param:
    api_response['status'] = '400'
    api_response['error'] = 'Missing required parameter: files'
    return api_response

  files_param = files_param.split(',')

  # Validate that files exist
  all_files = folder_paths.get_filename_list(model_type)
  valid_files = []
  for file_param in files_param:
    if file_param in all_files:
      valid_files.append(file_param)
    else:
      print(f"[Warning] File not found: {file_param}")

  if not valid_files:
    api_response['status'] = '404'
    api_response['error'] = 'No valid files found'
    return api_response

  # Process only the specified files
  for file_param in valid_files:
    info_data = await get_model_info(
      file_param,
      model_type,
      maybe_fetch_civitai=maybe_fetch_civitai,
      maybe_fetch_metadata=maybe_fetch_metadata,
      light=light
    )
    api_response['data'].append(info_data)
  return api_response
