importScripts("https://cdn.jsdelivr.net/pyodide/v0.21.3/full/pyodide.js");

function sendPatch(patch, buffers, msg_id) {
  self.postMessage({
    type: 'patch',
    patch: patch,
    buffers: buffers
  })
}

async function startApplication() {
  console.log("Loading pyodide!");
  self.postMessage({type: 'status', msg: 'Loading pyodide'})
  self.pyodide = await loadPyodide();
  self.pyodide.globals.set("sendPatch", sendPatch);
  console.log("Loaded!");
  await self.pyodide.loadPackage("micropip");
  const env_spec = ['https://cdn.holoviz.org/panel/0.14.1/dist/wheels/bokeh-2.4.3-py3-none-any.whl', 'https://cdn.holoviz.org/panel/0.14.1/dist/wheels/panel-0.14.1-py3-none-any.whl', 'pyodide-http==0.1.0', 'PIL', 'numpy', 'requests', 'panel']
  for (const pkg of env_spec) {
    let pkg_name;
    if (pkg.endsWith('.whl')) {
      pkg_name = pkg.split('/').slice(-1)[0].split('-')[0]
    } else {
      pkg_name = pkg
    }
    self.postMessage({type: 'status', msg: `Installing ${pkg_name}`})
    try {
      await self.pyodide.runPythonAsync(`
        import micropip
        await micropip.install('${pkg}');
      `);
    } catch(e) {
      console.log(e)
      self.postMessage({
	type: 'status',
	msg: `Error while installing ${pkg_name}`
      });
    }
  }
  console.log("Packages loaded!");
  self.postMessage({type: 'status', msg: 'Executing code'})
  const code = `
  
import asyncio

from panel.io.pyodide import init_doc, write_doc

init_doc()

"""
Converts a rectangular image into a square by pasting it
into the center of a larger canvas.
"""

from io import BytesIO

import numpy as np
import panel as pn
import requests
from PIL import Image, ImageColor

RAW_CSS = """
nav#header {
    margin-left: auto;
    margin-right: auto;
    max-width: 1500px;
}

h1 {
    margin-left: 2%;
    margin-right: 2%;
    font-size: 4em;
    font-weight: bold;
}

h3 {
    margin-left: 2%;
    margin-right: 2%;
    font-size: 1.5em;
}

# text input
.bk.bk-input {
    font-size: 1.25em;
}

# download button
.bk .bk .bk.bk-input-group .bk-btn.bk-btn-default {
    font-size: 1.00em;
}

# card header
.bk.card .bk.card-header .bk.card-header-row .bk.card-title .bk.bk-clearfix {
    font-size: 1.25em;
}

# slider
.bk.bk-slider-title {
    font-size: 1.25em;
}

# button
.bk.bk-btn.bk-btn-default {
    font-size: 1.05em;
}

# layout
fast-card.pn-wrapper {
    padding: 0em;
    margin-top: 3%;
}
"""

FOOTER_LINE = """
<center>
App written entirely in Python using the magical
<a href="https://panel.holoviz.org/" target="_blank">Panel</a>.
If you'd like to subscribe for more apps like this,
follow <a href="https://twitter.com/IAteAnDrew1/" target="_blank">IAteAndrew1</a>
on Twitter or <a href="https://github.com/ahuang11/" target="_blank">ahuang11</a>
on GitHub!
</center>
"""

pn.extension(sizing_mode="stretch_width", raw_css=[RAW_CSS], notifications=True)


def squarify_image(image: Image) -> Image:
    """Expands canvas so that the output image is a square."""
    width, height = image.size
    input_card.title = f"Input Resolution: {width}x{height}"

    max_size = max(width, height)
    max_static_text.value = max_size
    desired_size = size_spinner.value
    if max_size < desired_size:
        size_spinner.value = max_size
        desired_size = max_size
    output_card.title = f"Output Resolution: {desired_size}x{desired_size}"

    center_x = (max_size - width) // 2
    center_y = (max_size - height) // 2

    square_image = Image.new("RGBA", (max_size, max_size), (255, 255, 255, 0))
    square_image.paste(image, (center_x, center_y))
    return square_image.resize((desired_size, desired_size))


def add_transparency(image: Image) -> Image:
    """Replaces background color with transparency.

    If detect checkbox is checked, uses the color found at the top left
    corner as the background color to replace.

    If match checkbox is checked, only mask out the specified color;
    else, mask the specified color and also fade away colors that are similar.
    """
    image_array = np.array(image.convert("RGBA"), dtype=np.ubyte) / 255.0

    if detect_checkbox.value:
        r, g, b, _ = (image_array[0, 0] * 255).astype(int)
        color_picker.value = "#{:02x}{:02x}{:02x}".format(r, g, b)
        pn.state.notifications.info(
            f"Detected background color: "
            f"{color_picker.value.upper()} ({r}, {g}, {b})",
            duration=2500,
        )

    target_color = np.array(ImageColor.getrgb(color_picker.value)) / 255.0
    if match_checkbox:
        image_array_rgba = image_array.copy()
        mask = (image_array_rgba[:, :, :3] == target_color).all(axis=2)
        alpha = np.where(mask | (image_array_rgba[:, :, -1] == 0), 0, 1)
        image_array_rgba[:, :, -1] = alpha
    else:
        alpha_array = np.max(
            [
                np.abs(image_array[..., 0] - target_color[0]),
                np.abs(image_array[..., 1] - target_color[1]),
                np.abs(image_array[..., 2] - target_color[2]),
            ],
            axis=0,
        )
        ny, nx, _ = image_array.shape
        image_array_rgba = np.zeros((ny, nx, 4), dtype=image_array.dtype)
        for i in range(3):
            image_array_rgba[..., i] = image_array[..., i]
        image_array_rgba[..., 3] = alpha_array

    return Image.fromarray(np.ubyte((image_array_rgba * 255).astype(int)))


def process_url(_):
    """Processes the specified URL.

    Specifically, downloads the image from specified URL, optionally adding
    transparency and converting the output image canvas into a square. Users
    can then download the output image. If an error occurs, a notification
    will pop-up on the bottom right corner.
    """
    submit_button.loading = True
    input_png.loading = True
    output_png.loading = True
    try:
        url = text_input.value_input
        response = requests.get(url)
        image_content = response.content

        with BytesIO(image_content) as input_buf:
            image = Image.open(input_buf)
            input_png.object = image
            if transparency_checkbox.value:
                image = add_transparency(image)
            image = squarify_image(image)
            output_png.object = image

        download_buf = BytesIO()
        image.save(download_buf, format="PNG")
        download_buf.seek(0)
        file_download.file = download_buf
        file_download.disabled = False
    except Exception as exc:
        pn.state.notifications.error(str(exc), duration=5000)
    finally:
        submit_button.loading = False
        input_png.loading = False
        output_png.loading = False


# disabling widgets
def disable_submit(target, event):
    """
    Disallow users from clicking submit if URL is empty.
    """
    target.disabled = len(event.new) == 0


def disable_transparency_widgets(target, event):
    """
    Disallow users from clicking any of the widgets.
    """
    target.disabled = not event.new


# layout header
text_input_placeholder = (
    "Right click an image online, copy image address, and paste it here to squarify it!"
)
text_input = pn.widgets.TextInput(placeholder=text_input_placeholder)
submit_button = pn.widgets.Button(
    name="Submit", disabled=True, width=200, height=32, sizing_mode="fixed"
)
file_download = pn.widgets.FileDownload(
    label="Download",
    filename="square_image.png",
    disabled=True,
    width=200,
    height=30,
    sizing_mode="fixed",
)
header_row = pn.Row(text_input, submit_button, file_download)

# layout png
input_png = pn.pane.PNG(
    max_width=600, max_height=600, sizing_mode="scale_both", align="center"
)
input_card = pn.Card(
    input_png,
    max_width=650,
    max_height=650,
    sizing_mode="stretch_both",
    align="center",
    margin=(0, 25),
    title="Input resolution: N/A",
    collapsible=False,
    header_color="grey",
)
output_png = pn.pane.PNG(
    max_width=600, max_height=600, sizing_mode="scale_both", align="center"
)
output_card = pn.Card(
    output_png,
    max_width=650,
    max_height=650,
    sizing_mode="stretch_both",
    align="center",
    margin=(0, 25),
    title="Output resolution: N/A",
    collapsible=False,
    header_color="grey",
)
png_row = pn.Row(
    input_card,
    output_card,
    width=1300,
    height=700,
    align="center",
)

# layout settings
size_spinner = pn.widgets.Spinner(
    name="Desired output size [px]", margin=(0, 10), value=500
)
max_static_text = pn.widgets.StaticText(name="Max image size [px]", value="N/A")
color_picker = pn.widgets.ColorPicker(
    name="Input background color", margin=(0, 10), value="#FFFFFF", disabled=True
)
transparency_checkbox = pn.widgets.Checkbox(
    name="Make background transparent", margin=(10, 10), align="center"
)
detect_checkbox = pn.widgets.Checkbox(
    name="Auto-detect background color", margin=(10, 10), align="center", disabled=True
)
match_checkbox = pn.widgets.Checkbox(
    name="Match color exactly", margin=(10, 0), disabled=True
)
checkbox_row = pn.Row(
    transparency_checkbox, detect_checkbox, match_checkbox, align="center"
)

# create settings pane
grid_box = pn.GridBox(
    color_picker,
    size_spinner,
    checkbox_row,
    max_static_text,
    ncols=2,
)

# create footer
footer = pn.pane.Markdown(
    FOOTER_LINE,
    style={"color": "grey"},
)

# layout main
main_column = pn.Column(
    png_row,
    grid_box,
    footer,
)

# link widgets
text_input.link(submit_button, callbacks={"value_input": disable_submit})
transparency_checkbox.link(
    detect_checkbox, callbacks={"value": disable_transparency_widgets}
)
transparency_checkbox.link(
    match_checkbox, callbacks={"value": disable_transparency_widgets}
)
transparency_checkbox.link(
    color_picker, callbacks={"value": disable_transparency_widgets}
)
detect_checkbox.link(color_picker, value="disabled")
submit_button.on_click(process_url)

# populate template
template = pn.template.FastListTemplate(
    title="Squarify",
    header=[header_row],
    main=[main_column],
    main_max_width="1500px",
    accent="fast",
    shadow=False,
    theme=pn.template.theme.DarkTheme,
)
template.servable()


await write_doc()
  `

  try {
    const [docs_json, render_items, root_ids] = await self.pyodide.runPythonAsync(code)
    self.postMessage({
      type: 'render',
      docs_json: docs_json,
      render_items: render_items,
      root_ids: root_ids
    })
  } catch(e) {
    const traceback = `${e}`
    const tblines = traceback.split('\n')
    self.postMessage({
      type: 'status',
      msg: tblines[tblines.length-2]
    });
    throw e
  }
}

self.onmessage = async (event) => {
  const msg = event.data
  if (msg.type === 'rendered') {
    self.pyodide.runPythonAsync(`
    from panel.io.state import state
    from panel.io.pyodide import _link_docs_worker

    _link_docs_worker(state.curdoc, sendPatch, setter='js')
    `)
  } else if (msg.type === 'patch') {
    self.pyodide.runPythonAsync(`
    import json

    state.curdoc.apply_json_patch(json.loads('${msg.patch}'), setter='js')
    `)
    self.postMessage({type: 'idle'})
  } else if (msg.type === 'location') {
    self.pyodide.runPythonAsync(`
    import json
    from panel.io.state import state
    from panel.util import edit_readonly
    if state.location:
        loc_data = json.loads("""${msg.location}""")
        with edit_readonly(state.location):
            state.location.param.update({
                k: v for k, v in loc_data.items() if k in state.location.param
            })
    `)
  }
}

startApplication()
