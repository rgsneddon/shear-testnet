#include "my_application.h"

#include <flutter_linux/flutter_linux.h>
#ifdef GDK_WINDOWING_X11
#include <gdk/gdkx.h>
#endif

#include "flutter/generated_plugin_registrant.h"

#include <string.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/time.h>

static gboolean g_hop_up = FALSE;

static void privacy_hop_method_cb(FlMethodChannel* channel,
                                  FlMethodCall* method_call,
                                  gpointer user_data) {
  const gchar* method = fl_method_call_get_name(method_call);
  g_autoptr(FlValue) out = fl_value_new_map();
  if (g_strcmp0(method, "connect") == 0) {
    int s = socket(AF_INET, SOCK_DGRAM, 0);
    if (s < 0) {
      fl_value_set_string_take(out, "ok", fl_value_new_bool(FALSE));
      fl_value_set_string_take(out, "connected", fl_value_new_bool(FALSE));
      fl_value_set_string_take(
          out, "message", fl_value_new_string("UDP socket failed"));
      fl_method_call_respond_success(method_call, out, nullptr);
      return;
    }
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons(44044);
    inet_pton(AF_INET, "77.42.35.12", &addr.sin_addr);
    const char magic[] = "RPT2";
    sendto(s, magic, 4, 0, (struct sockaddr*)&addr, sizeof(addr));
    struct timeval tv;
    tv.tv_sec = 2;
    tv.tv_usec = 0;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    char buf[64];
    int n = recvfrom(s, buf, sizeof(buf), 0, nullptr, nullptr);
    close(s);
    g_hop_up = FALSE;
    fl_value_set_string_take(out, "ok", fl_value_new_bool(FALSE));
    fl_value_set_string_take(out, "connected", fl_value_new_bool(FALSE));
    fl_value_set_string_take(out, "fullTunnelActive", fl_value_new_bool(FALSE));
    fl_value_set_string_take(
        out, "message",
        fl_value_new_string(
            n > 0
                ? "SHEAR-HOP / EU is reachable on UDP 44044. Linux TUN residual "
                  "HELLO is not in this cut — use Privacy hop on Android, or "
                  "Send without privacy hop."
                : "No residual HELLO reply from SHEAR-HOP / EU. Use Privacy hop "
                  "on Android, or Send without privacy hop."));
    fl_method_call_respond_success(method_call, out, nullptr);
    return;
  }
  if (g_strcmp0(method, "disconnect") == 0) {
    g_hop_up = FALSE;
    fl_value_set_string_take(out, "ok", fl_value_new_bool(TRUE));
    fl_value_set_string_take(out, "connected", fl_value_new_bool(FALSE));
    fl_value_set_string_take(out, "message", fl_value_new_string("Disconnected"));
    fl_method_call_respond_success(method_call, out, nullptr);
    return;
  }
  if (g_strcmp0(method, "status") == 0) {
    fl_value_set_string_take(out, "ok", fl_value_new_bool(g_hop_up));
    fl_value_set_string_take(out, "connected", fl_value_new_bool(g_hop_up));
    fl_value_set_string_take(out, "fullTunnelActive", fl_value_new_bool(g_hop_up));
    fl_value_set_string_take(
        out, "message",
        fl_value_new_string(g_hop_up ? "SHEAR-HOP / EU up" : "Hop off"));
    fl_method_call_respond_success(method_call, out, nullptr);
    return;
  }
  fl_method_call_respond_not_implemented(method_call, nullptr);
}

struct _MyApplication {
  GtkApplication parent_instance;
  char** dart_entrypoint_arguments;
};

G_DEFINE_TYPE(MyApplication, my_application, GTK_TYPE_APPLICATION)

// Called when first Flutter frame received.
static void first_frame_cb(MyApplication* self, FlView* view) {
  gtk_widget_show(gtk_widget_get_toplevel(GTK_WIDGET(view)));
}

// Implements GApplication::activate.
static void my_application_activate(GApplication* application) {
  MyApplication* self = MY_APPLICATION(application);
  GtkWindow* window =
      GTK_WINDOW(gtk_application_window_new(GTK_APPLICATION(application)));

  // Use a header bar when running in GNOME as this is the common style used
  // by applications and is the setup most users will be using (e.g. Ubuntu
  // desktop).
  // If running on X and not using GNOME then just use a traditional title bar
  // in case the window manager does more exotic layout, e.g. tiling.
  // If running on Wayland assume the header bar will work (may need changing
  // if future cases occur).
  gboolean use_header_bar = TRUE;
#ifdef GDK_WINDOWING_X11
  GdkScreen* screen = gtk_window_get_screen(window);
  if (GDK_IS_X11_SCREEN(screen)) {
    const gchar* wm_name = gdk_x11_screen_get_window_manager_name(screen);
    if (g_strcmp0(wm_name, "GNOME Shell") != 0) {
      use_header_bar = FALSE;
    }
  }
#endif
  if (use_header_bar) {
    GtkHeaderBar* header_bar = GTK_HEADER_BAR(gtk_header_bar_new());
    gtk_widget_show(GTK_WIDGET(header_bar));
    gtk_header_bar_set_title(header_bar, "Shear 0.46");
    gtk_header_bar_set_show_close_button(header_bar, TRUE);
    gtk_window_set_titlebar(window, GTK_WIDGET(header_bar));
  } else {
    gtk_window_set_title(window, "Shear 0.46");
  }

  gtk_window_set_default_size(window, 1280, 720);
  {
    g_autofree gchar* exe = g_file_read_link("/proc/self/exe", NULL);
    if (exe != NULL) {
      g_autofree gchar* dir = g_path_get_dirname(exe);
      g_autofree gchar* icon =
          g_build_filename(dir, "data", "app_icon.png", NULL);
      gtk_window_set_icon_from_file(window, icon, NULL);
    }
  }

  g_autoptr(FlDartProject) project = fl_dart_project_new();
  fl_dart_project_set_dart_entrypoint_arguments(
      project, self->dart_entrypoint_arguments);

  FlView* view = fl_view_new(project);
  GdkRGBA background_color;
  // Background defaults to black, override it here if necessary, e.g. #00000000
  // for transparent.
  gdk_rgba_parse(&background_color, "#000000");
  fl_view_set_background_color(view, &background_color);
  gtk_widget_show(GTK_WIDGET(view));
  gtk_container_add(GTK_CONTAINER(window), GTK_WIDGET(view));

  // Show the window when Flutter renders.
  // Requires the view to be realized so we can start rendering.
  g_signal_connect_swapped(view, "first-frame", G_CALLBACK(first_frame_cb),
                           self);
  gtk_widget_realize(GTK_WIDGET(view));

  fl_register_plugins(FL_PLUGIN_REGISTRY(view));
  {
    FlEngine* engine = fl_view_get_engine(view);
    g_autoptr(FlStandardMethodCodec) codec = fl_standard_method_codec_new();
    g_autoptr(FlMethodChannel) hop = fl_method_channel_new(
        fl_engine_get_binary_messenger(engine), "shear/privacy_hop",
        FL_METHOD_CODEC(codec));
    fl_method_channel_set_method_call_handler(hop, privacy_hop_method_cb,
                                              nullptr, nullptr);
  }

  gtk_widget_grab_focus(GTK_WIDGET(view));
}

// Implements GApplication::local_command_line.
static gboolean my_application_local_command_line(GApplication* application,
                                                  gchar*** arguments,
                                                  int* exit_status) {
  MyApplication* self = MY_APPLICATION(application);
  // Strip out the first argument as it is the binary name.
  self->dart_entrypoint_arguments = g_strdupv(*arguments + 1);

  g_autoptr(GError) error = nullptr;
  if (!g_application_register(application, nullptr, &error)) {
    g_warning("Failed to register: %s", error->message);
    *exit_status = 1;
    return TRUE;
  }

  g_application_activate(application);
  *exit_status = 0;

  return TRUE;
}

// Implements GApplication::startup.
static void my_application_startup(GApplication* application) {
  // MyApplication* self = MY_APPLICATION(object);

  // Perform any actions required at application startup.

  G_APPLICATION_CLASS(my_application_parent_class)->startup(application);
}

// Implements GApplication::shutdown.
static void my_application_shutdown(GApplication* application) {
  // MyApplication* self = MY_APPLICATION(object);

  // Perform any actions required at application shutdown.

  G_APPLICATION_CLASS(my_application_parent_class)->shutdown(application);
}

// Implements GObject::dispose.
static void my_application_dispose(GObject* object) {
  MyApplication* self = MY_APPLICATION(object);
  g_clear_pointer(&self->dart_entrypoint_arguments, g_strfreev);
  G_OBJECT_CLASS(my_application_parent_class)->dispose(object);
}

static void my_application_class_init(MyApplicationClass* klass) {
  G_APPLICATION_CLASS(klass)->activate = my_application_activate;
  G_APPLICATION_CLASS(klass)->local_command_line =
      my_application_local_command_line;
  G_APPLICATION_CLASS(klass)->startup = my_application_startup;
  G_APPLICATION_CLASS(klass)->shutdown = my_application_shutdown;
  G_OBJECT_CLASS(klass)->dispose = my_application_dispose;
}

static void my_application_init(MyApplication* self) {}

MyApplication* my_application_new() {
  // Set the program name to the application ID, which helps various systems
  // like GTK and desktop environments map this running application to its
  // corresponding .desktop file. This ensures better integration by allowing
  // the application to be recognized beyond its binary name.
  g_set_prgname(APPLICATION_ID);

  return MY_APPLICATION(g_object_new(my_application_get_type(),
                                     "application-id", APPLICATION_ID, "flags",
                                     G_APPLICATION_NON_UNIQUE, nullptr));
}
