package mayhemdoclet;

import com.sun.source.doctree.AttributeTree;
import com.sun.source.doctree.DeprecatedTree;
import com.sun.source.doctree.DocCommentTree;
import com.sun.source.doctree.DocTree;
import com.sun.source.doctree.EndElementTree;
import com.sun.source.doctree.EntityTree;
import com.sun.source.doctree.LinkTree;
import com.sun.source.doctree.LiteralTree;
import com.sun.source.doctree.ParamTree;
import com.sun.source.doctree.ReturnTree;
import com.sun.source.doctree.SeeTree;
import com.sun.source.doctree.SinceTree;
import com.sun.source.doctree.StartElementTree;
import com.sun.source.doctree.TextTree;
import com.sun.source.doctree.ThrowsTree;
import com.sun.source.doctree.ValueTree;
import com.sun.source.tree.Tree;
import com.sun.source.tree.VariableTree;
import com.sun.source.util.DocTreePath;
import com.sun.source.util.DocTrees;
import com.sun.source.util.TreePath;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import javax.lang.model.SourceVersion;
import javax.lang.model.element.Element;
import javax.lang.model.element.ElementKind;
import javax.lang.model.element.ExecutableElement;
import javax.lang.model.element.Modifier;
import javax.lang.model.element.PackageElement;
import javax.lang.model.element.TypeElement;
import javax.lang.model.element.TypeParameterElement;
import javax.lang.model.element.VariableElement;
import javax.lang.model.type.ArrayType;
import javax.lang.model.type.DeclaredType;
import javax.lang.model.type.TypeKind;
import javax.lang.model.type.TypeMirror;
import javax.lang.model.type.TypeVariable;
import javax.lang.model.type.WildcardType;
import javax.lang.model.util.ElementFilter;
import javax.lang.model.util.Elements;
import javax.lang.model.util.Types;
import jdk.javadoc.doclet.Doclet;
import jdk.javadoc.doclet.DocletEnvironment;
import jdk.javadoc.doclet.Reporter;

/**
 * Writes MayhemLib's public API and its doc comments as one JSON file, which the docs site turns
 * into its API reference pages (site/api/). Comments are rendered to HTML here; links to MayhemLib
 * elements use the placeholder prefix {@code @api/} (the site adds its base path), and links to
 * WPILib and java.base types point at their hosted Javadoc.
 *
 * <p>Usage: {@code ./gradlew apiJson} (see lib/build.gradle).
 */
public final class ApiJsonDoclet implements Doclet {
  private static final String ROOT = "mayhemlib";
  private static final String WPILIB_DOCS = "https://github.wpilib.org/allwpilib/docs/release/java/";
  private static final String JAVA_DOCS = "https://docs.oracle.com/en/java/javase/17/docs/api/java.base/";

  private Reporter reporter;
  private String out;
  private String version = "";
  private DocTrees trees;
  private Elements elements;
  private Types types;

  @Override
  public void init(Locale locale, Reporter reporter) {
    this.reporter = reporter;
  }

  @Override
  public String getName() {
    return "ApiJsonDoclet";
  }

  @Override
  public SourceVersion getSupportedSourceVersion() {
    return SourceVersion.latest();
  }

  @Override
  public Set<? extends Option> getSupportedOptions() {
    return Set.of(
        new Opt("-out", 1, "Output JSON file", a -> out = a),
        new Opt("-apiversion", 1, "Library version recorded in the JSON", a -> version = a),
        // Passed by Gradle's Javadoc task whatever the doclet; ignored.
        new Opt("-d", 1, "Ignored", a -> {}),
        new Opt("-doctitle", 1, "Ignored", a -> {}),
        new Opt("-windowtitle", 1, "Ignored", a -> {}),
        new Opt("-notimestamp", 0, "Ignored", a -> {}));
  }

  @Override
  public boolean run(DocletEnvironment env) {
    if (out == null) {
      reporter.print(javax.tools.Diagnostic.Kind.ERROR, "ApiJsonDoclet: -out <file> is required");
      return false;
    }
    trees = env.getDocTrees();
    elements = env.getElementUtils();
    types = env.getTypeUtils();

    Map<String, List<TypeElement>> byPackage = new java.util.TreeMap<>();
    for (TypeElement t : ElementFilter.typesIn(env.getIncludedElements())) {
      if (isDocumented(t)) {
        byPackage.computeIfAbsent(elements.getPackageOf(t).getQualifiedName().toString(),
            k -> new ArrayList<>()).add(t);
      }
    }

    List<Object> packages = new ArrayList<>();
    for (var e : byPackage.entrySet()) {
      PackageElement pkg = elements.getPackageElement(e.getKey());
      Map<String, Object> p = new LinkedHashMap<>();
      p.put("name", e.getKey());
      p.put("slug", pkgSlug(e.getKey()));
      putDoc(p, pkg);
      List<TypeElement> ts = e.getValue();
      ts.sort(Comparator.comparing(this::nestedName));
      p.put("types", ts.stream().map(this::type).collect(Collectors.toList()));
      packages.add(p);
    }

    Map<String, Object> root = new LinkedHashMap<>();
    root.put("version", version);
    root.put("packages", packages);
    try {
      Path path = Path.of(out);
      if (path.getParent() != null) {
        Files.createDirectories(path.getParent());
      }
      Files.writeString(path, Json.write(root) + "\n", StandardCharsets.UTF_8);
    } catch (IOException ex) {
      reporter.print(javax.tools.Diagnostic.Kind.ERROR, "ApiJsonDoclet: " + ex.getMessage());
      return false;
    }
    return true;
  }

  // ------------------------------------------------------------------------------------ model

  private boolean isDocumented(Element e) {
    for (Element x = e; x != null && x.getKind() != ElementKind.PACKAGE; x = x.getEnclosingElement()) {
      if (!x.getModifiers().contains(Modifier.PUBLIC)) {
        return false;
      }
    }
    return true;
  }

  private static String pkgSlug(String pkg) {
    return pkg.equals(ROOT) ? "root" : pkg.substring(ROOT.length() + 1).replace('.', '-');
  }

  /** "Outer.Inner" for nested types, "Name" otherwise. */
  private String nestedName(TypeElement t) {
    String q = t.getQualifiedName().toString();
    String pkg = elements.getPackageOf(t).getQualifiedName().toString();
    return q.substring(pkg.length() + 1);
  }

  private String typeUrl(TypeElement t) {
    String pkg = elements.getPackageOf(t).getQualifiedName().toString();
    return "@api/" + pkgSlug(pkg) + "/" + nestedName(t).replace('.', '/');
  }

  private static String kind(TypeElement t) {
    switch (t.getKind()) {
      case INTERFACE: return "interface";
      case ENUM: return "enum";
      case ANNOTATION_TYPE: return "annotation";
      default: return t.getKind().name().equals("RECORD") ? "record" : "class";
    }
  }

  private Map<String, Object> type(TypeElement t) {
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("name", nestedName(t));
    m.put("kind", kind(t));
    m.put("url", typeUrl(t));
    m.put("modifiers", modifiers(t));
    m.put("signature", typeSignature(t));
    putDoc(m, t);
    if (t.getEnclosingElement() instanceof TypeElement) {
      m.put("enclosing", nestedName((TypeElement) t.getEnclosingElement()));
    }

    Set<String> ids = new HashSet<>();
    List<Object> constants = new ArrayList<>();
    List<Object> fields = new ArrayList<>();
    for (VariableElement f : ElementFilter.fieldsIn(t.getEnclosedElements())) {
      if (!f.getModifiers().contains(Modifier.PUBLIC) && f.getKind() != ElementKind.ENUM_CONSTANT) {
        continue;
      }
      Map<String, Object> fm = new LinkedHashMap<>();
      fm.put("name", f.getSimpleName().toString());
      fm.put("anchor", unique(ids, f.getSimpleName().toString().toLowerCase(Locale.ROOT)));
      putDoc(fm, f);
      if (f.getKind() == ElementKind.ENUM_CONSTANT) {
        constants.add(fm);
        continue;
      }
      fm.put("modifiers", modifiers(f));
      fm.put("type", typeHtml(f.asType()));
      fm.put("typeText", typeText(f.asType()));
      String init = initializer(f);
      if (init != null) {
        fm.put("default", init);
      }
      fields.add(fm);
    }

    List<Object> ctors = new ArrayList<>();
    for (ExecutableElement c : ElementFilter.constructorsIn(t.getEnclosedElements())) {
      if (c.getModifiers().contains(Modifier.PUBLIC) && t.getKind() != ElementKind.ENUM) {
        ctors.add(executable(c, t, ids));
      }
    }

    List<Object> methods = new ArrayList<>();
    for (ExecutableElement x : ElementFilter.methodsIn(t.getEnclosedElements())) {
      if (x.getModifiers().contains(Modifier.PUBLIC)
          && elements.getOrigin(x) == Elements.Origin.EXPLICIT) {
        methods.add(executable(x, t, ids));
      }
    }

    List<Object> nested = new ArrayList<>();
    for (TypeElement n : ElementFilter.typesIn(t.getEnclosedElements())) {
      if (isDocumented(n)) {
        Map<String, Object> nm = new LinkedHashMap<>();
        nm.put("name", nestedName(n));
        nm.put("kind", kind(n));
        nm.put("url", typeUrl(n));
        putSummary(nm, n);
        nested.add(nm);
      }
    }

    m.put("enumConstants", constants);
    m.put("fields", fields);
    m.put("constructors", ctors);
    m.put("methods", methods);
    m.put("nested", nested);
    return m;
  }

  private static String unique(Set<String> ids, String id) {
    String base = id;
    for (int i = 2; !ids.add(id); i++) {
      id = base + "-" + i;
    }
    return id;
  }

  private Map<String, Object> executable(ExecutableElement x, TypeElement owner, Set<String> ids) {
    boolean ctor = x.getKind() == ElementKind.CONSTRUCTOR;
    String name = ctor ? owner.getSimpleName().toString() : x.getSimpleName().toString();
    Map<String, Object> m = new LinkedHashMap<>();
    m.put("name", name);
    m.put("kind", ctor ? "constructor" : "method");

    String anchorBase = ctor ? "constructor" : name.toLowerCase(Locale.ROOT);
    String paramKey = x.getParameters().stream()
        .map(p -> simpleErasure(p.asType()).toLowerCase(Locale.ROOT))
        .collect(Collectors.joining("-"));
    m.put("anchor", unique(ids, paramKey.isEmpty() ? anchorBase : anchorBase + "-" + paramKey));
    m.put("modifiers", modifiers(x));
    if (!x.getTypeParameters().isEmpty()) {
      m.put("typeParams", typeParams(x.getTypeParameters()));
    }
    if (!ctor) {
      m.put("returns", typeHtml(x.getReturnType()));
      m.put("returnsText", typeText(x.getReturnType()));
    }

    DocCommentTree dc = trees.getDocCommentTree(x);
    Map<String, String> paramDocs = new LinkedHashMap<>();
    String returnDoc = null;
    List<Object> throwsDocs = new ArrayList<>();
    if (dc != null) {
      for (DocTree b : dc.getBlockTags()) {
        if (b instanceof ParamTree && !((ParamTree) b).isTypeParameter()) {
          ParamTree pt = (ParamTree) b;
          paramDocs.put(pt.getName().getName().toString(), html(x, dc, pt.getDescription()));
        } else if (b instanceof ReturnTree) {
          returnDoc = html(x, dc, ((ReturnTree) b).getDescription());
        } else if (b instanceof ThrowsTree) {
          ThrowsTree tt = (ThrowsTree) b;
          Map<String, Object> th = new LinkedHashMap<>();
          th.put("type", tt.getExceptionName().getSignature());
          th.put("doc", html(x, dc, tt.getDescription()));
          throwsDocs.add(th);
        }
      }
    }

    List<Object> params = new ArrayList<>();
    StringBuilder text = new StringBuilder(name).append('(');
    for (int i = 0; i < x.getParameters().size(); i++) {
      VariableElement p = x.getParameters().get(i);
      boolean varargs = x.isVarArgs() && i == x.getParameters().size() - 1;
      Map<String, Object> pm = new LinkedHashMap<>();
      String pname = p.getSimpleName().toString();
      pm.put("name", pname);
      TypeMirror pt = varargs ? ((ArrayType) p.asType()).getComponentType() : p.asType();
      pm.put("type", typeHtml(pt) + (varargs ? "..." : ""));
      pm.put("typeText", typeText(pt) + (varargs ? "..." : ""));
      if (paramDocs.containsKey(pname)) {
        pm.put("doc", paramDocs.get(pname));
      }
      params.add(pm);
      text.append(i == 0 ? "" : ", ").append(typeText(pt)).append(varargs ? "..." : "");
    }
    m.put("params", params);
    m.put("shortSignature", text.append(')').toString());
    if (returnDoc != null) {
      m.put("returnDoc", returnDoc);
    }
    if (!throwsDocs.isEmpty()) {
      m.put("throws", throwsDocs);
    }
    List<String> thrown = x.getThrownTypes().stream().map(this::typeHtml).collect(Collectors.toList());
    if (!thrown.isEmpty()) {
      m.put("thrownTypes", thrown);
    }
    putDoc(m, x);
    if (!ctor && dc == null) {
      String from = overridden(x, owner);
      if (from != null) {
        m.put("specifiedBy", from);
      }
    }
    return m;
  }

  /** The type (as linked HTML) that declares the method {@code x} overrides, if any. */
  private String overridden(ExecutableElement x, TypeElement owner) {
    List<TypeMirror> supers = new ArrayList<>(types.directSupertypes(owner.asType()));
    Set<String> seen = new HashSet<>();
    while (!supers.isEmpty()) {
      TypeMirror s = supers.remove(0);
      Element se = types.asElement(s);
      if (!(se instanceof TypeElement) || !seen.add(se.toString())) {
        continue;
      }
      for (ExecutableElement m : ElementFilter.methodsIn(se.getEnclosedElements())) {
        if (elements.overrides(x, m, owner)) {
          return typeHtml(types.erasure(s));
        }
      }
      supers.addAll(types.directSupertypes(s));
    }
    return null;
  }

  /**
   * The field's initializer as written. The javadoc tool drops non-constant initializers from its
   * trees, so this reads the declaration from the source text.
   */
  private String initializer(VariableElement f) {
    TreePath path = trees.getPath(f);
    if (path == null || !(path.getLeaf() instanceof VariableTree)) {
      return null;
    }
    try {
      var cu = path.getCompilationUnit();
      CharSequence src = cu.getSourceFile().getCharContent(true);
      long start = trees.getSourcePositions().getStartPosition(cu, path.getLeaf());
      if (start < 0) {
        return null;
      }
      String name = f.getSimpleName().toString();
      int i = (int) start;
      // Skip annotations, modifiers and the type up to "name".
      java.util.regex.Matcher m = java.util.regex.Pattern
          .compile("\\b" + java.util.regex.Pattern.quote(name) + "\\s*(=|;|,)")
          .matcher(src);
      if (!m.find(i) || !m.group(1).equals("=")) {
        return null;
      }
      int depth = 0;
      int j = m.end();
      for (; j < src.length(); j++) {
        char c = src.charAt(j);
        if (c == '(' || c == '{' || c == '[') {
          depth++;
        } else if (c == ')' || c == '}' || c == ']') {
          depth--;
        } else if ((c == ';' || c == ',') && depth == 0) {
          break;
        }
      }
      String s = src.subSequence(m.end(), j).toString().replaceAll("\\s+", " ").trim();
      return s.isEmpty() || s.length() > 80 ? null : s;
    } catch (IOException ex) {
      return null;
    }
  }

  private static List<String> modifiers(Element e) {
    return e.getModifiers().stream()
        .filter(m -> m != Modifier.STRICTFP)
        .map(Modifier::toString)
        .collect(Collectors.toList());
  }

  private String typeParams(List<? extends TypeParameterElement> tps) {
    return "&lt;" + tps.stream().map(tp -> {
      String bounds = tp.getBounds().stream()
          .filter(b -> !b.toString().equals("java.lang.Object"))
          .map(this::typeHtml).collect(Collectors.joining(" &amp; "));
      return esc(tp.getSimpleName().toString()) + (bounds.isEmpty() ? "" : " extends " + bounds);
    }).collect(Collectors.joining(", ")) + "&gt;";
  }

  private String typeSignature(TypeElement t) {
    StringBuilder sb = new StringBuilder();
    List<String> mods = modifiers(t);
    if (t.getKind() == ElementKind.INTERFACE || t.getKind() == ElementKind.ENUM) {
      mods.remove("abstract");
      mods.remove("final");
      mods.remove("static");
    }
    for (String mod : mods) {
      sb.append("<span class=\"kw\">").append(mod).append("</span> ");
    }
    String kw = t.getKind() == ElementKind.ANNOTATION_TYPE ? "@interface" : kind(t);
    sb.append("<span class=\"kw\">").append(kw).append("</span> ")
        .append("<span class=\"name\">").append(esc(t.getSimpleName().toString())).append("</span>");
    if (!t.getTypeParameters().isEmpty()) {
      sb.append(typeParams(t.getTypeParameters()));
    }
    TypeMirror sup = t.getSuperclass();
    if (t.getKind() == ElementKind.CLASS && sup.getKind() == TypeKind.DECLARED
        && !sup.toString().equals("java.lang.Object")) {
      sb.append(" <span class=\"kw\">extends</span> ").append(typeHtml(sup));
    }
    List<String> ifaces = t.getInterfaces().stream().map(this::typeHtml).collect(Collectors.toList());
    if (!ifaces.isEmpty()) {
      sb.append(" <span class=\"kw\">")
          .append(t.getKind() == ElementKind.INTERFACE ? "extends" : "implements")
          .append("</span> ").append(String.join(", ", ifaces));
    }
    return sb.toString();
  }

  // ------------------------------------------------------------------------------------ types

  private String simpleErasure(TypeMirror t) {
    TypeMirror e = types.erasure(t);
    if (e.getKind() == TypeKind.ARRAY) {
      return simpleErasure(((ArrayType) e).getComponentType()) + "[]";
    }
    if (e.getKind() == TypeKind.DECLARED) {
      return ((DeclaredType) e).asElement().getSimpleName().toString();
    }
    return e.toString();
  }

  private String typeText(TypeMirror t) {
    return typeRender(t, false);
  }

  private String typeHtml(TypeMirror t) {
    return typeRender(t, true);
  }

  private String typeRender(TypeMirror t, boolean html) {
    switch (t.getKind()) {
      case ARRAY:
        return typeRender(((ArrayType) t).getComponentType(), html) + "[]";
      case TYPEVAR:
        return esc(((TypeVariable) t).asElement().getSimpleName().toString());
      case WILDCARD: {
        WildcardType w = (WildcardType) t;
        if (w.getExtendsBound() != null) {
          return "? extends " + typeRender(w.getExtendsBound(), html);
        }
        if (w.getSuperBound() != null) {
          return "? super " + typeRender(w.getSuperBound(), html);
        }
        return "?";
      }
      case DECLARED: {
        DeclaredType d = (DeclaredType) t;
        TypeElement te = (TypeElement) d.asElement();
        String name = te.getSimpleName().toString();
        if (te.getEnclosingElement() instanceof TypeElement) {
          name = ((TypeElement) te.getEnclosingElement()).getSimpleName() + "." + name;
        }
        String s = html ? link(te, esc(name)) : name;
        if (!d.getTypeArguments().isEmpty()) {
          String lt = html ? "&lt;" : "<";
          String gt = html ? "&gt;" : ">";
          s += lt + d.getTypeArguments().stream().map(a -> typeRender(a, html))
              .collect(Collectors.joining(", ")) + gt;
        }
        return s;
      }
      default:
        return t.toString();
    }
  }

  /** Wraps {@code label} in a link to {@code e}'s docs when we know where they are. */
  private String link(Element e, String label) {
    String url = url(e);
    return url == null ? label : "<a href=\"" + esc(url) + "\">" + label + "</a>";
  }

  private String url(Element e) {
    TypeElement owner = e instanceof TypeElement ? (TypeElement) e
        : e.getEnclosingElement() instanceof TypeElement ? (TypeElement) e.getEnclosingElement() : null;
    if (owner == null) {
      if (e instanceof PackageElement && e.toString().startsWith(ROOT)) {
        return "@api/#" + pkgSlug(e.toString());
      }
      return null;
    }
    String pkg = elements.getPackageOf(owner).getQualifiedName().toString();
    String fragment = "";
    if (e != owner) {
      fragment = "#" + memberAnchor(e);
    }
    if (pkg.equals(ROOT) || pkg.startsWith(ROOT + ".")) {
      return isDocumented(owner) ? typeUrl(owner) + fragment : null;
    }
    String file = pkg.replace('.', '/') + "/" + nestedName(owner) + ".html";
    if (pkg.startsWith("edu.wpi.first.")) {
      return WPILIB_DOCS + file;
    }
    if (pkg.startsWith("java.lang") || pkg.startsWith("java.util")) {
      return JAVA_DOCS + file;
    }
    return null;
  }

  /** The anchor {@link #type} gives a member (ignoring rare collisions with fields). */
  private String memberAnchor(Element e) {
    if (e instanceof ExecutableElement) {
      ExecutableElement x = (ExecutableElement) e;
      String base = x.getKind() == ElementKind.CONSTRUCTOR ? "constructor"
          : x.getSimpleName().toString().toLowerCase(Locale.ROOT);
      String key = x.getParameters().stream()
          .map(p -> simpleErasure(p.asType()).toLowerCase(Locale.ROOT))
          .collect(Collectors.joining("-"));
      return key.isEmpty() ? base : base + "-" + key;
    }
    return e.getSimpleName().toString().toLowerCase(Locale.ROOT);
  }

  // ------------------------------------------------------------------------------------ comments

  private void putDoc(Map<String, Object> m, Element e) {
    DocCommentTree dc = trees.getDocCommentTree(e);
    if (dc == null) {
      return;
    }
    String body = html(e, dc, dc.getFullBody());
    String extra = null;
    // "MayhemLib extra: ..." marks API that ChoreoLib does not have.
    String stripped = body.replaceFirst("^MayhemLib extra:\\s*", "");
    if (!stripped.equals(body) && !stripped.isEmpty()) {
      m.put("mayhemOnly", true);
      body = Character.toUpperCase(stripped.charAt(0)) + stripped.substring(1);
    }
    m.put("doc", body);
    m.put("summary", summary(e, dc));
    List<Object> see = new ArrayList<>();
    for (DocTree b : dc.getBlockTags()) {
      if (b instanceof SeeTree) {
        see.add(html(e, dc, ((SeeTree) b).getReference()));
      } else if (b instanceof SinceTree) {
        m.put("since", html(e, dc, ((SinceTree) b).getBody()));
      } else if (b instanceof DeprecatedTree) {
        extra = html(e, dc, ((DeprecatedTree) b).getBody());
        m.put("deprecated", extra.isEmpty() ? "Deprecated." : extra);
      }
    }
    if (!see.isEmpty()) {
      m.put("see", see);
    }
  }

  private void putSummary(Map<String, Object> m, Element e) {
    DocCommentTree dc = trees.getDocCommentTree(e);
    if (dc != null) {
      m.put("summary", summary(e, dc));
    }
  }

  private String summary(Element e, DocCommentTree dc) {
    String s = html(e, dc, dc.getFirstSentence());
    String stripped = s.replaceFirst("^MayhemLib extra:\\s*", "");
    return stripped.equals(s) || stripped.isEmpty() ? s
        : Character.toUpperCase(stripped.charAt(0)) + stripped.substring(1);
  }

  private String html(Element owner, DocCommentTree dc, List<? extends DocTree> body) {
    StringBuilder sb = new StringBuilder();
    boolean[] inPre = {false};
    for (DocTree t : body) {
      render(owner, dc, t, sb, inPre);
    }
    return sb.toString().trim();
  }

  private void render(Element owner, DocCommentTree dc, DocTree t, StringBuilder sb, boolean[] inPre) {
    switch (t.getKind()) {
      case TEXT:
        sb.append(((TextTree) t).getBody());
        break;
      case ENTITY:
        sb.append('&').append(((EntityTree) t).getName()).append(';');
        break;
      case START_ELEMENT: {
        StartElementTree s = (StartElementTree) t;
        String name = s.getName().toString();
        if (name.equalsIgnoreCase("pre")) {
          inPre[0] = true;
        }
        sb.append('<').append(name);
        for (DocTree a : s.getAttributes()) {
          AttributeTree at = (AttributeTree) a;
          sb.append(' ').append(at.getName());
          if (at.getValueKind() != AttributeTree.ValueKind.EMPTY) {
            StringBuilder v = new StringBuilder();
            for (DocTree vt : at.getValue()) {
              render(owner, dc, vt, v, inPre);
            }
            sb.append("=\"").append(v.toString().replace("\"", "&quot;")).append('"');
          }
        }
        sb.append(s.isSelfClosing() ? "/>" : ">");
        break;
      }
      case END_ELEMENT: {
        String name = ((EndElementTree) t).getName().toString();
        if (name.equalsIgnoreCase("pre")) {
          inPre[0] = false;
        }
        sb.append("</").append(name).append('>');
        break;
      }
      case CODE:
      case LITERAL: {
        String body = ((LiteralTree) t).getBody().getBody();
        if (inPre[0] && t.getKind() == DocTree.Kind.CODE) {
          sb.append("<code class=\"language-java\">").append(esc(body)).append("</code>");
        } else if (t.getKind() == DocTree.Kind.CODE) {
          sb.append("<code>").append(esc(body)).append("</code>");
        } else {
          sb.append(esc(body));
        }
        break;
      }
      case LINK:
      case LINK_PLAIN: {
        LinkTree l = (LinkTree) t;
        String sig = l.getReference().getSignature();
        StringBuilder label = new StringBuilder();
        for (DocTree lt : l.getLabel()) {
          render(owner, dc, lt, label, inPre);
        }
        String text = label.length() > 0 ? label.toString().trim() : esc(prettyRef(sig));
        if (t.getKind() == DocTree.Kind.LINK && label.length() == 0) {
          text = "<code>" + text + "</code>";
        }
        Element target = trees.getElement(DocTreePath.getPath(trees.getPath(owner), dc, l.getReference()));
        sb.append(target == null ? text : link(target, text));
        break;
      }
      case REFERENCE: {
        // @see target
        var ref = (com.sun.source.doctree.ReferenceTree) t;
        Element target = trees.getElement(DocTreePath.getPath(trees.getPath(owner), dc, ref));
        String text = "<code>" + esc(prettyRef(ref.getSignature())) + "</code>";
        sb.append(target == null ? text : link(target, text));
        break;
      }
      case VALUE: {
        ValueTree v = (ValueTree) t;
        sb.append("<code>").append(v.getReference() == null ? "" : esc(prettyRef(v.getReference().getSignature())))
            .append("</code>");
        break;
      }
      default:
        // Unknown inline tags render as their source text.
        sb.append(esc(t.toString()));
    }
  }

  /** "AutoFactory#withUnbeach()" -> "AutoFactory.withUnbeach()", "#done()" -> "done()". */
  private static String prettyRef(String sig) {
    String s = sig.startsWith("#") ? sig.substring(1) : sig.replace('#', '.');
    int paren = s.indexOf('(');
    String head = paren < 0 ? s : s.substring(0, paren);
    String tail = paren < 0 ? "" : s.substring(paren);
    // Drop package prefixes: mayhemlib.ctre.CtreSwerve.autoFactory -> CtreSwerve.autoFactory
    String[] parts = head.split("\\.");
    int first = 0;
    while (first < parts.length && !(parts[first].length() > 0 && Character.isUpperCase(parts[first].charAt(0)))) {
      first++;
    }
    if (first < parts.length) {
      head = String.join(".", java.util.Arrays.copyOfRange(parts, first, parts.length));
    }
    return head + tail.replaceAll("\\b(?:[a-z]\\w*\\.)+(?=[A-Z])", "");
  }

  private static String esc(String s) {
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
  }

  // ------------------------------------------------------------------------------------ plumbing

  private static final class Opt implements Doclet.Option {
    private final String name;
    private final int args;
    private final String description;
    private final java.util.function.Consumer<String> action;

    Opt(String name, int args, String description, java.util.function.Consumer<String> action) {
      this.name = name;
      this.args = args;
      this.description = description;
      this.action = action;
    }

    @Override public int getArgumentCount() { return args; }
    @Override public String getDescription() { return description; }
    @Override public Kind getKind() { return Kind.STANDARD; }
    @Override public List<String> getNames() { return List.of(name); }
    @Override public String getParameters() { return args == 0 ? "" : "<value>"; }

    @Override
    public boolean process(String option, List<String> arguments) {
      action.accept(arguments.isEmpty() ? "" : arguments.get(0));
      return true;
    }
  }

  /** Minimal JSON writer for maps, lists, strings, numbers and booleans. */
  private static final class Json {
    static String write(Object o) {
      StringBuilder sb = new StringBuilder();
      write(o, sb, 0);
      return sb.toString();
    }

    private static void write(Object o, StringBuilder sb, int indent) {
      if (o instanceof Map) {
        Map<?, ?> m = (Map<?, ?>) o;
        if (m.isEmpty()) {
          sb.append("{}");
          return;
        }
        sb.append("{\n");
        int i = 0;
        for (var e : m.entrySet()) {
          sb.append("  ".repeat(indent + 1));
          string(e.getKey().toString(), sb);
          sb.append(": ");
          write(e.getValue(), sb, indent + 1);
          sb.append(++i < m.size() ? ",\n" : "\n");
        }
        sb.append("  ".repeat(indent)).append('}');
      } else if (o instanceof List) {
        List<?> l = (List<?>) o;
        if (l.isEmpty()) {
          sb.append("[]");
          return;
        }
        sb.append("[\n");
        for (int i = 0; i < l.size(); i++) {
          sb.append("  ".repeat(indent + 1));
          write(l.get(i), sb, indent + 1);
          sb.append(i + 1 < l.size() ? ",\n" : "\n");
        }
        sb.append("  ".repeat(indent)).append(']');
      } else if (o instanceof String) {
        string((String) o, sb);
      } else {
        sb.append(o);
      }
    }

    private static void string(String s, StringBuilder sb) {
      sb.append('"');
      for (char c : s.toCharArray()) {
        switch (c) {
          case '"': sb.append("\\\""); break;
          case '\\': sb.append("\\\\"); break;
          case '\n': sb.append("\\n"); break;
          case '\r': break;
          case '\t': sb.append("\\t"); break;
          default:
            if (c < 0x20) {
              sb.append(String.format("\\u%04x", (int) c));
            } else {
              sb.append(c);
            }
        }
      }
      sb.append('"');
    }
  }
}
